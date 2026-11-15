package io.snailecho;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.function.UnaryOperator;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
@Transactional(isolation = Isolation.READ_COMMITTED)
class ComparisonService {
    private static final Set<String> REVIEW_STAGES = Set.of("SPEAKER_LABELING", "MUTUAL_CONFIRM");
    private static final Pattern SENTENCE = Pattern.compile("[^。！？!?\\r\\n]+[。！？!?]?");
    private static final Pattern PUNCTUATION = Pattern.compile("[\\p{P}\\s]+", Pattern.UNICODE_CHARACTER_CLASS);

    record Item(String id, String category, String original, String speakerQuote, String listenerQuote,
                boolean complete, boolean accurate, String clarification, Feedback feedback) {
        boolean problem() { return !complete || !accurate; }
        Item withFeedback(Feedback changed) {
            return new Item(id, category, original, speakerQuote, listenerQuote, complete, accurate, clarification, changed);
        }
    }
    record Feedback(String tag, String resolution, boolean speakerConfirmed, boolean listenerConfirmed,
                    String listenerNote, String observerTag, String observerNote) {
        Feedback label(String tag, String resolution) {
            if (tag.equals(this.tag) && resolution.equals(this.resolution)) return this;
            return new Feedback(tag, resolution, false, false, listenerNote, observerTag, observerNote);
        }
        Feedback clarify(String note) {
            if (note.equals(listenerNote)) return this;
            return new Feedback(tag, resolution, false, false, note, observerTag, observerNote);
        }
        Feedback observe(String tag, String note) {
            return new Feedback(this.tag, resolution, speakerConfirmed, listenerConfirmed, listenerNote, tag, note);
        }
        Feedback confirm(String role) {
            return new Feedback(tag, resolution, speakerConfirmed || "speaker".equals(role),
                    listenerConfirmed || "listener".equals(role), listenerNote, observerTag, observerNote);
        }
    }
    record Review(List<Item> items, boolean adviceAccepted) {}
    record Label(String issueId, String tag, String resolution) {}
    record Issue(String id, String category, String original, String speakerQuote, String listenerQuote,
                 boolean complete, boolean accurate, String tag, String clarification, String resolution,
                 boolean speakerConfirmed, boolean listenerConfirmed, String listenerNote,
                 String observerTag, String observerNote) {
        Issue(Item item) {
            this(item.id(), item.category(), item.original(), item.speakerQuote(), item.listenerQuote(),
                    item.complete(), item.accurate(), item.feedback().tag(), item.clarification(), item.feedback().resolution(),
                    item.feedback().speakerConfirmed(), item.feedback().listenerConfirmed(), item.feedback().listenerNote(),
                    item.feedback().observerTag(), item.feedback().observerNote());
        }
    }
    record Transcripts(String speaker, String listener) {}
    record Report(String topic, String focus, String speaker, String listener, String speakerAudioId,
                  String listenerAudioId, int hintLevel) {}
    record View(int total, long complete, long accurate, List<Issue> issues, boolean adviceAccepted,
                Transcripts transcripts, Report report, String provider) {}
    record Practice(long complete, int total) {}
    record Updated(String id, String stage, long version) {}
    private record Access(RoomMapper.Room room, RoomMapper.Round round, String role) {}

    private final RoomMapper rooms;
    private final AudioMapper audio;
    private final PointMapper points;
    private final TranscriptionMapper transcripts;
    private final ComparisonMapper comparisons;
    private final TextVault vault;
    private final ObjectMapper json;

    ComparisonService(RoomMapper rooms, AudioMapper audio, PointMapper points, TranscriptionMapper transcripts,
                      ComparisonMapper comparisons, TextVault vault, ObjectMapper json) {
        this.rooms = rooms;
        this.audio = audio;
        this.points = points;
        this.transcripts = transcripts;
        this.comparisons = comparisons;
        this.vault = vault;
        this.json = json;
    }

    public void build(ComparisonMapper.Candidate candidate) {
        var round = lockCandidate(candidate);
        if (round == null) return;
        // The candidate query makes pending jobs eligible only when the database deadline expires.
        String listener = transcript(round.listenerAudioId());
        var confirmed = points.list(round.id());
        if (listener == null || confirmed.isEmpty()) {
            cancelComparison(candidate.roomId(), round);
            return;
        }
        var speakerSentences = sentences(transcript(round.speakerAudioId()));
        var listenerSentences = sentences(listener);
        var items = confirmed.stream().map(point -> {
            String original = vault.open("point:" + point.id(), point.contentCiphertext());
            String phrase = normalize(original);
            String speakerQuote = matchingSentence(phrase, speakerSentences);
            String listenerQuote = matchingSentence(phrase, listenerSentences);
            boolean match = listenerQuote != null && normalize(listenerQuote).contains(phrase);
            String tag = match ? null : listenerQuote == null ? "遗漏重要信息" : "理解不到位";
            return new Item(point.id(), point.category(), original, speakerQuote,
                    listenerQuote == null ? "" : listenerQuote, match, match,
                    listenerQuote != null && !match ? "这句是否保留了表达者确认的要点？" : null,
                    new Feedback(tag, null, false, false, null, null, null));
        }).toList();
        comparisons.insert(round.id(), seal(round.id(), new Review(items, false)));
        advance(round, "SPEAKER_LABELING");
        rooms.advanceVersion(candidate.roomId());
    }

    public void expireFailed(ComparisonMapper.Candidate candidate) {
        var round = lockCandidate(candidate);
        if (round != null && comparisons.deadlinePassed(round.id())) {
            cancelComparison(candidate.roomId(), round);
        }
    }

    private RoomMapper.Round lockCandidate(ComparisonMapper.Candidate candidate) {
        var room = rooms.lockRoom(candidate.roomId());
        if (room == null || !"ACTIVE".equals(room.status())) return null;
        var round = rooms.latestRound(room.id());
        if (round == null || !round.id().equals(candidate.id()) || round.version() != candidate.version()
                || !"COMPARING".equals(round.stage())) return null;
        return round;
    }

    private void cancelComparison(String roomId, RoomMapper.Round round) {
        advance(round, "CANCELLED");
        transcripts.cancelPendingForRound(round.id());
        rooms.resetReadiness(roomId);
        rooms.setStatus(roomId, "WAITING");
    }

    public Practice previousPractice(String roomId, String actor) {
        String id = comparisons.latestArchive(roomId, actor);
        if (id == null) return null;
        var stored = comparisons.load(id);
        if (stored == null) return null;
        Review review;
        try {
            review = decode(id, stored);
        } catch (IllegalStateException unreadableReport) {
            return null;
        }
        return review.adviceAccepted()
                ? new Practice(review.items().stream().filter(Item::complete).count(), review.items().size()) : null;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public View view(String id, String actor) {
        var access = access(id, actor, false);
        var round = access.round();
        boolean archived = "ARCHIVED".equals(round.stage());
        if (!archived && !REVIEW_STAGES.contains(round.stage()) && !"ADVICE".equals(round.stage())) {
            throw new ApiFailure(409, "COMPARISON_PENDING");
        }
        var review = load(id);
        var items = review.items();
        long complete = items.stream().filter(Item::complete).count();
        long accurate = items.stream().filter(Item::accurate).count();
        Transcripts texts = null;
        if (archived || complete == items.size() && accurate == items.size()) {
            String speaker = transcript(round.speakerAudioId());
            String listener = transcript(round.listenerAudioId());
            if (speaker != null && listener != null) texts = new Transcripts(speaker, listener);
        }
        Report report = null;
        if (archived) {
            var details = comparisons.report(id);
            report = new Report(access.room().topic(), details.focus(), details.speaker(), details.listener(),
                    round.speakerAudioId(), round.listenerAudioId(), details.hintLevel());
        }
        return new View(items.size(), complete, accurate, items.stream().map(Issue::new).toList(),
                review.adviceAccepted(), texts, report, "mock");
    }

    public Updated label(String id, String actor, long version, List<Label> labels) {
        var access = edit(id, actor, version, "speaker", "SPEAKER_LABELING");
        var review = load(id);
        var problemIds = review.items().stream().filter(Item::problem).map(Item::id).collect(Collectors.toSet());
        var submitted = labels.stream().map(Label::issueId).collect(Collectors.toSet());
        if (submitted.size() != labels.size() || !submitted.equals(problemIds)) {
            throw new ApiFailure(400, "LABELS_MUST_COVER_ALL_ISSUES");
        }
        for (var label : labels) {
            review = editIssue(review, label.issueId(), feedback -> feedback.label(label.tag(), label.resolution()));
        }
        return persist(access, review, "MUTUAL_CONFIRM");
    }

    public Updated revise(String id, String actor, long version, Label label) {
        var access = edit(id, actor, version, "speaker", "MUTUAL_CONFIRM");
        return changeIssue(access, label.issueId(), item -> item.label(label.tag(), label.resolution()));
    }

    public Updated clarify(String id, String actor, long version, String issueId, String note) {
        var access = edit(id, actor, version, "listener", "MUTUAL_CONFIRM");
        return changeIssue(access, issueId, feedback -> feedback.clarify(note));
    }

    public Updated observe(String id, String actor, long version, String issueId, String tag, String note) {
        var access = edit(id, actor, version, "observer", "SPEAKER_LABELING", "MUTUAL_CONFIRM");
        return changeIssue(access, issueId, feedback -> feedback.observe(tag, note));
    }

    public Updated confirm(String id, String actor, long version, String issueId) {
        var access = edit(id, actor, version, null, "MUTUAL_CONFIRM");
        if ("observer".equals(access.role())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        return changeIssue(access, issueId, feedback -> feedback.confirm(access.role()));
    }

    public Updated submit(String id, String actor, long version) {
        var access = edit(id, actor, version, "speaker", "MUTUAL_CONFIRM");
        var review = load(id);
        if (review.items().stream().filter(Item::problem).map(Item::feedback)
                .anyMatch(item -> !item.speakerConfirmed() || !item.listenerConfirmed())) {
            throw new ApiFailure(409, "CONFIRMATIONS_REQUIRED");
        }
        return persist(access, review, "ADVICE");
    }

    public Updated adopt(String id, String actor, long version) {
        var access = edit(id, actor, version, "speaker", "ADVICE");
        var review = load(id);
        if (review.adviceAccepted()) return current(access.round());
        return persist(access, new Review(review.items(), true), "ADVICE");
    }

    private Updated changeIssue(Access access, String issueId, UnaryOperator<Feedback> change) {
        var review = load(access.round().id());
        var changed = editIssue(review, issueId, change);
        if (review.equals(changed)) return current(access.round());
        return persist(access, changed, access.round().stage());
    }

    private static Review editIssue(Review review, String issueId, UnaryOperator<Feedback> change) {
        var items = new ArrayList<>(review.items());
        for (int i = 0; i < items.size(); i++) {
            var item = items.get(i);
            if (item.id().equals(issueId) && item.problem()) {
                items.set(i, item.withFeedback(change.apply(item.feedback())));
                return new Review(List.copyOf(items), review.adviceAccepted());
            }
        }
        throw new ApiFailure(404, "ISSUE_NOT_FOUND");
    }

    private Access access(String id, String actor, boolean lock) {
        String roomId = rooms.roundRoom(id);
        if (roomId == null) throw new ApiFailure(404, "ROUND_NOT_FOUND");
        var room = lock ? rooms.lockRoom(roomId) : rooms.room(roomId);
        var member = rooms.members(roomId).stream().filter(row -> actor.equals(row.sessionId())).findFirst()
                .orElseThrow(() -> new ApiFailure(403, "NOT_ROOM_MEMBER"));
        var round = audio.round(id);
        String role = actor.equals(round.speakerSessionId()) ? "speaker"
                : actor.equals(round.listenerSessionId()) ? "listener" : member.role().equals("observer") ? "observer" : null;
        boolean archived = "ARCHIVED".equals(round.stage());
        if (role == null || archived && "observer".equals(role)) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        if (lock || !archived) {
            if (!"ACTIVE".equals(room.status()) || !id.equals(rooms.latestRound(roomId).id())) {
                throw new ApiFailure(409, "ROOM_NOT_ACTIVE");
            }
        }
        return new Access(room, round, role);
    }

    private Access edit(String id, String actor, long version, String role, String... stages) {
        var access = access(id, actor, true);
        if (role != null && !role.equals(access.role())) throw new ApiFailure(403, "FORBIDDEN_ROLE");
        if (access.round().version() != version) throw new ApiFailure(409, "STALE_VERSION");
        if (!Set.of(stages).contains(access.round().stage())) throw new ApiFailure(409, "WRONG_STAGE");
        return access;
    }

    private Updated persist(Access access, Review review, String stage) {
        var round = access.round();
        comparisons.save(round.id(), seal(round.id(), review));
        advance(round, stage);
        rooms.advanceVersion(access.room().id());
        return new Updated(round.id(), stage, round.version() + 1);
    }

    private static Updated current(RoomMapper.Round round) {
        return new Updated(round.id(), round.stage(), round.version());
    }

    private void advance(RoomMapper.Round round, String stage) {
        if (comparisons.advance(round.id(), round.stage(), round.version(), stage) != 1) {
            throw new ApiFailure(409, "STALE_VERSION");
        }
    }

    private Review load(String id) {
        var stored = comparisons.load(id);
        if (stored == null) throw new ApiFailure(409, "COMPARISON_UNAVAILABLE");
        return decode(id, stored);
    }

    private Review decode(String id, ComparisonMapper.StoredReview stored) {
        try {
            return json.readValue(vault.open("comparison:" + id, stored.ciphertext()), Review.class);
        } catch (JsonProcessingException invalid) {
            throw new IllegalStateException("Invalid comparison");
        }
    }

    private byte[] seal(String id, Review review) {
        try {
            return vault.seal("comparison:" + id, json.writeValueAsString(review));
        } catch (JsonProcessingException invalid) {
            throw new IllegalStateException("Unable to serialize comparison");
        }
    }

    private String transcript(String audioId) {
        if (audioId == null) return null;
        var job = transcripts.byId(audioId);
        return job != null && "DONE".equals(job.status())
                ? vault.open("transcript:" + audioId, job.resultCiphertext()) : null;
    }

    private static List<String> sentences(String text) {
        return text == null ? List.of() : SENTENCE.matcher(text).results().map(match -> match.group().strip()).toList();
    }

    private static String normalize(String text) {
        return PUNCTUATION.matcher(text).replaceAll("");
    }

    // The local mock uses exact wording for acceptance and shared bigrams only to find a possible original quote.
    private static String matchingSentence(String phrase, List<String> sentences) {
        if (phrase.isEmpty()) return null;
        String best = null;
        int highest = 0;
        for (String sentence : sentences) {
            String normalized = normalize(sentence);
            if (normalized.contains(phrase)) return sentence;
            int score = 0;
            for (int i = 1; i < phrase.length(); i++) {
                if (normalized.contains(phrase.substring(i - 1, i + 1))) score++;
            }
            if (score > highest) {
                highest = score;
                best = sentence;
            }
        }
        return best;
    }
}

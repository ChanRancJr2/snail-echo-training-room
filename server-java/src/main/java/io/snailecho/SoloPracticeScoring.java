package io.snailecho;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "echo.processing.enabled", havingValue = "true")
class SoloPracticeScoring {
    private static final Logger LOG = LoggerFactory.getLogger(SoloPracticeScoring.class);
    private static final Pattern WORDS = Pattern.compile("[\\p{P}\\s]");
    private final Map<String, Material> materials;
    private final Optional<ArkComparison> ark;

    record Check(int sourceIndex, List<String> keywords, String tag, String question) {}
    record Material(String id, String topic, String title, List<String> source,
                    List<String> keywords, List<Check> checks, String advice) {}
    record Item(String id, String original, String retell, String tag, String question, boolean complete, boolean accurate) {}
    record Comparison(List<Item> rows, List<Item> issues, int total, int complete, int accurate) {}
    record Outcome(Comparison comparison, String provider) {}

    SoloPracticeScoring(ObjectMapper json, Optional<ArkComparison> ark) {
        try (var source = new ClassPathResource("practice-materials.json").getInputStream()) {
            materials = Arrays.stream(json.readValue(source, Material[].class))
                    .collect(Collectors.toUnmodifiableMap(Material::id, Function.identity()));
        } catch (IOException failure) {
            throw new UncheckedIOException(failure);
        }
        this.ark = ark;
    }

    void validateMaterial(String id) {
        if (!materials.containsKey(id)) throw new ApiFailure(400, "INVALID_INPUT");
    }

    Outcome compare(String materialId, String transcript) {
        var rows = new ArrayList<>(rules(materials.get(materialId), transcript));
        String provider = "rules";
        if (ark.isPresent()) {
            var points = rows.stream().map(row -> new ArkComparison.Point(row.id(), "重点", row.original())).toList();
            try {
                var decisions = ArkComparison.retryTransient(() -> ark.get().compare(points, transcript));
                provider = decisions.size() == rows.size() ? "ark" : decisions.isEmpty() ? "rules_fallback" : "ark_partial";
                rows.replaceAll(row -> {
                    var decision = decisions.get(row.id());
                    return decision == null ? row : new Item(row.id(), row.original(), decision.listenerQuote(),
                            decision.tag() == null ? "要点吻合" : decision.tag(),
                            decision.clarification() == null ? "" : decision.clarification(),
                            decision.complete(), decision.accurate());
                });
            } catch (ArkComparison.Failure failure) {
                LOG.warn("Solo semantic comparison fell back to rules ({})", failure.getMessage());
                provider = "rules_fallback";
            }
        }
        return new Outcome(scores(List.copyOf(rows)), provider);
    }

    private static Comparison scores(List<Item> rows) {
        return new Comparison(rows, rows.stream().filter(row -> !row.complete() || !row.accurate()).toList(),
                rows.size(), (int) rows.stream().filter(Item::complete).count(), (int) rows.stream().filter(Item::accurate).count());
    }

    private static List<Item> rules(Material material, String transcript) {
        var sentences = transcript.split("(?<=[。！？!?；;])|\\R");
        return material.checks().stream().map(check -> {
            String quote = "";
            long best = 0;
            var keywords = check.keywords().stream().map(SoloPracticeScoring::normalize).toList();
            for (String sentence : sentences) {
                String normalized = normalize(sentence);
                long score = keywords.stream().filter(normalized::contains).count();
                if (score > best) {
                    best = score;
                    quote = sentence.strip();
                }
            }
            boolean accurate = best > 0 && best == keywords.size();
            return new Item("source-" + check.sourceIndex(), material.source().get(check.sourceIndex()), quote,
                    accurate ? "要点吻合" : check.tag(), accurate ? "" : check.question(), best > 0, accurate);
        }).toList();
    }

    private static String normalize(String value) {
        return WORDS.matcher(Normalizer.normalize(value, Normalizer.Form.NFKC)).replaceAll("").toLowerCase(Locale.ROOT);
    }
}

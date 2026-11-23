package io.snailecho;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

record WholeRoundFeedback(List<String> retellTags, List<String> expressionTags, String note) {
    private static final Set<String> RETELL = Set.of("遗漏重要信息", "理解不到位", "理解偏了", "杜撰信息", "强加信息", "重点被误解");
    private static final Set<String> EXPRESSION = Set.of("我表达不清", "我言不达意", "语气被误解");

    static WholeRoundFeedback create(List<String> retellTags, List<String> expressionTags, String note) {
        return new WholeRoundFeedback(validate(retellTags, RETELL), validate(expressionTags, EXPRESSION),
                note == null ? "" : note.strip());
    }

    private static List<String> validate(List<String> tags, Set<String> allowed) {
        if (tags == null || tags.size() > allowed.size() || new HashSet<>(tags).size() != tags.size()
                || tags.stream().anyMatch(tag -> tag == null || !allowed.contains(tag))) {
            throw new ApiFailure(400, "INVALID_INPUT");
        }
        return List.copyOf(tags);
    }
}

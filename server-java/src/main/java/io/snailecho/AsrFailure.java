package io.snailecho;

final class AsrFailure extends RuntimeException {
    private final boolean retryable;

    AsrFailure(String code, boolean retryable) {
        super(code);
        this.retryable = retryable;
    }

    boolean retryable() { return retryable; }
}

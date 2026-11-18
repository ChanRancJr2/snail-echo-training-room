package io.snailecho;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

final class ApiFailure extends RuntimeException {
    private final int status;

    ApiFailure(int status, String code) {
        super(code);
        this.status = status;
    }

    static ApiFailure invalid() {
        return new ApiFailure(400, "INVALID_INPUT");
    }

    @RestControllerAdvice
    static class Handler {
        @ExceptionHandler(ApiFailure.class)
        ResponseEntity<Map<String, String>> domain(ApiFailure error) {
            return ResponseEntity.status(error.status).body(Map.of("error", error.getMessage()));
        }

        @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
                MethodArgumentTypeMismatchException.class})
        ResponseEntity<Map<String, String>> invalidInput() {
            return domain(invalid());
        }
    }
}

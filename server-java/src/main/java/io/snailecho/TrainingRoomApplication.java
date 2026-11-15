package io.snailecho;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class TrainingRoomApplication {
    public static void main(String[] args) {
        SpringApplication.run(TrainingRoomApplication.class, args);
    }
}

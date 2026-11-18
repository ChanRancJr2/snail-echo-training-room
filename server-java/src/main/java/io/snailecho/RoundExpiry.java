package io.snailecho;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
class RoundExpiry {
    private final RoomMapper database;
    private final RoomService rooms;

    RoundExpiry(RoomMapper database, RoomService rooms) {
        this.database = database;
        this.rooms = rooms;
    }

    @Scheduled(fixedDelayString = "${echo.round-sweep-delay-ms:5000}",
            initialDelayString = "${echo.round-sweep-delay-ms:5000}")
    public void sweep() {
        for (var due : database.dueRecordings()) {
            rooms.expireRecording(due);
        }
    }
}

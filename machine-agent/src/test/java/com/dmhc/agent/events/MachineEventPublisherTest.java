package com.dmhc.agent.events;

import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import java.io.IOException;
import java.io.OutputStream;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class MachineEventPublisherTest {
    @Test
    void slowBrowserCannotBlockControllerEventPublisher() throws Exception {
        MachineEventPublisher publisher = new MachineEventPublisher();
        BlockingOutputStream browser = new BlockingOutputStream();
        publisher.subscribe(browser);

        publisher.publish("controller.message", "head-1", "Grbl 0.9j ['$' for help]", "info", null);
        browser.writeStarted.await(1, TimeUnit.SECONDS);

        assertTimeoutPreemptively(
            Duration.ofMillis(200),
            () -> publisher.publish("controller.status", "head-2", "Idle", "info", null)
        );
        assertTimeoutPreemptively(
            Duration.ofMillis(200),
            () -> publisher.keepAlive(browser, java.time.Instant.now())
        );

        publisher.unsubscribe(browser);
    }

    private static final class BlockingOutputStream extends OutputStream {
        private final CountDownLatch writeStarted = new CountDownLatch(1);

        @Override
        public void write(int value) throws IOException {
            writeStarted.countDown();
            try {
                Thread.sleep(10_000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted", interrupted);
            }
        }
    }
}
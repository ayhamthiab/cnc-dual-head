package com.dmhc.agent.controller;

import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.dmhc.agent.events.MachineEventPublisher;
import com.willwinder.universalgcodesender.GrblController;
import com.willwinder.universalgcodesender.listeners.ControllerState;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class ControllerSessionLockingTest {
    @Test
    void controllerCallbackDoesNotWaitForConnectSessionMonitor() throws Exception {
        ControllerSession session = new ControllerSession("head-1", 1, new MachineEventPublisher());
        TestGrblController controller = new TestGrblController();
        configure(session, controller);
        setController(session, controller);

        CountDownLatch monitorHeld = new CountDownLatch(1);
        CountDownLatch releaseMonitor = new CountDownLatch(1);
        Thread connectingThread = new Thread(() -> {
            synchronized (session) {
                monitorHeld.countDown();
                try {
                    releaseMonitor.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
        connectingThread.start();

        try {
            if (!monitorHeld.await(1, TimeUnit.SECONDS)) {
                throw new AssertionError("Test thread did not acquire the session monitor");
            }
            assertTimeoutPreemptively(
                Duration.ofMillis(200),
                () -> controller.emitState(ControllerState.CONNECTING)
            );
        } finally {
            releaseMonitor.countDown();
            connectingThread.join(1_000);
        }
    }

    @Test
    void staleControllerCallbackCannotReplaceCurrentSnapshot() throws Exception {
        ControllerSession session = new ControllerSession("head-1", 1, new MachineEventPublisher());
        TestGrblController oldController = new TestGrblController();
        TestGrblController currentController = new TestGrblController();
        configure(session, oldController);
        setController(session, currentController);

        Field snapshotField = ControllerSession.class.getDeclaredField("snapshot");
        snapshotField.setAccessible(true);
        Object before = snapshotField.get(session);

        oldController.emitState(ControllerState.IDLE);

        assertSame(before, snapshotField.get(session));
    }

    private void configure(ControllerSession session, GrblController controller) throws Exception {
        Method configure = ControllerSession.class.getDeclaredMethod("configureListeners", GrblController.class);
        configure.setAccessible(true);
        configure.invoke(session, controller);
    }

    private void setController(ControllerSession session, GrblController controller) throws Exception {
        Field controllerField = ControllerSession.class.getDeclaredField("controller");
        controllerField.setAccessible(true);
        controllerField.set(session, controller);
    }

    private static final class TestGrblController extends GrblController {
        private void emitState(ControllerState state) {
            setControllerState(state);
        }
    }
}
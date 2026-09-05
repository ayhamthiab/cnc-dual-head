package com.dmhc.agent.controller;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.dmhc.agent.events.MachineEventPublisher;
import com.willwinder.universalgcodesender.GrblController;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class SessionGrblControllerTest {
    @Test
    void orphanOkIsDiscardedAndReportedToTheOwningHeadConsole() throws Exception {
        MachineEventPublisher events = new MachineEventPublisher();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        events.subscribe(output);

        ControllerSession session = new ControllerSession("head-1", 1, events);
        SessionGrblController controller = new SessionGrblController();
        configure(session, controller);
        setController(session, controller);

        Method responseHandler = SessionGrblController.class
            .getDeclaredMethod("rawResponseHandler", String.class);
        responseHandler.setAccessible(true);
        responseHandler.invoke(controller, "ok");

        String event = awaitEvent(output);
        assertTrue(event.contains("\"event\":\"controller.message\""));
        assertTrue(event.contains("\"controllerId\":\"head-1\""));
        assertTrue(event.contains("\"level\":\"error\""));
        assertTrue(event.contains("UGS response ownership error"));
        assertTrue(event.contains("stale/late response was not assigned to another command"));

        events.unsubscribe(output);
    }

    private String awaitEvent(ByteArrayOutputStream output) throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            synchronized (output) {
                String current = output.toString(StandardCharsets.UTF_8);
                if (current.contains("UGS response ownership error")) return current;
            }
            Thread.sleep(10);
        }
        throw new AssertionError("Timed out waiting for the controller error event.");
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
}
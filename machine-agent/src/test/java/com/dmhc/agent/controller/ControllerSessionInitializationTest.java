package com.dmhc.agent.controller;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import org.junit.jupiter.api.Test;

import com.dmhc.agent.automation.DrawingAutomation;
import com.dmhc.agent.events.MachineEventPublisher;
import com.willwinder.universalgcodesender.GrblController;
import com.willwinder.universalgcodesender.connection.ConnectionDriver;
import com.willwinder.universalgcodesender.listeners.ControllerState;

class ControllerSessionInitializationTest {
    @Test
    void completedGrblHandshakeEnablesStatusResolutionAndRemainsConnected() throws Exception {
        HandshakeController controller = new HandshakeController(true);
        ControllerSession session = new ControllerSession(
            "head-1",
            1,
            new MachineEventPublisher(),
            () -> controller
        );

        session.connect("COM6", 115200);

        MachineStatusSnapshot snapshot = session.snapshot();
        assertTrue(controller.isCommOpen());
        assertTrue(controller.statusUpdatesEnabled);
        assertTrue(snapshot.connected());
        assertEquals("COM6", snapshot.port());
        assertEquals("IDLE", snapshot.state());
        assertEquals(List.of("$X"), controller.unlocks);
        assertEquals(
            List.of(
                "Grbl 0.9j ['$' for help]",
                "<Alarm,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000>",
                "$I",
                "$$",
                "$G",
                "*** Connected to GRBL 0.9j"
            ),
            controller.handshake
        );
    }

    @Test
    void completedGrblHandshakeDoesNotUnlockAnIdleController() throws Exception {
        HandshakeController controller = new HandshakeController(false);
        ControllerSession session = new ControllerSession(
            "head-2",
            2,
            new MachineEventPublisher(),
            () -> controller
        );

        session.connect("COM9", 115200);

        assertTrue(session.snapshot().connected());
        assertEquals("IDLE", session.snapshot().state());
        assertTrue(controller.unlocks.isEmpty());
    }

    @Test
    void workPositionToleranceAllowsSmallSetupOffsetDrift() {
        assertTrue(DrawingAutomation.positionWithinTolerance(-60.0d, -208.6d, -60.0d, -208.5d, 0.1d));
        assertTrue(DrawingAutomation.positionWithinTolerance(-60.1d, -208.4d, -60.0d, -208.5d, 0.1d));
        assertFalse(DrawingAutomation.positionWithinTolerance(-61.0d, -209.5d, -60.0d, -208.5d, 0.1d));
    }

    private static final class HandshakeController extends GrblController {
        private final List<String> handshake = new ArrayList<>();
        private final List<String> unlocks = new ArrayList<>();
        private final boolean startsInAlarm;
        private boolean open;
        private boolean statusUpdatesEnabled;

        private HandshakeController(boolean startsInAlarm) {
            this.startsInAlarm = startsInAlarm;
        }

        @Override
        public Boolean openCommPort(ConnectionDriver driver, String port, int rate) {
            open = true;
            setControllerState(ControllerState.CONNECTING);
            emit("Grbl 0.9j ['$' for help]");
            emit("<Alarm,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000>");
            emit("$I");
            emit("$$");
            emit("$G");
            emit("*** Connected to GRBL 0.9j");
            return true;
        }

        @Override
        public Boolean isCommOpen() {
            return open;
        }

        @Override
        public void setStatusUpdateRate(int rate) {
            assertEquals(250, rate);
        }

        @Override
        public void setStatusUpdatesEnabled(boolean enabled) {
            statusUpdatesEnabled = enabled;
            if (enabled) setControllerState(startsInAlarm ? ControllerState.ALARM : ControllerState.IDLE);
        }

        @Override
        public void killAlarmLock() {
            unlocks.add("$X");
            setControllerState(ControllerState.IDLE);
        }

        @Override
        public void requestStatusReport() {}

        @Override
        public Boolean closeCommPort() {
            open = false;
            return true;
        }

        private void emit(String message) {
            handshake.add(message);
            getMessageService().dispatchMessage(
                message.startsWith("***") ? com.willwinder.universalgcodesender.listeners.MessageType.INFO
                    : com.willwinder.universalgcodesender.listeners.MessageType.VERBOSE,
                message
            );
        }
    }
}
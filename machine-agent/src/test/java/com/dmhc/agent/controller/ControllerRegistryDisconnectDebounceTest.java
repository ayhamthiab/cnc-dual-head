package com.dmhc.agent.controller;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import org.junit.jupiter.api.Test;

import com.dmhc.agent.events.MachineEventPublisher;

class ControllerRegistryDisconnectDebounceTest {
    private static final String OPERATION = "setup movement";

    @Test
    void toleratesOneTransientDisconnectedReading() {
        ControllerRegistry registry = new ControllerRegistry(new MachineEventPublisher());

        assertDoesNotThrow(() -> registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false)));
    }

    @Test
    void confirmsDisconnectOnFourthConsecutiveReading() {
        ControllerRegistry registry = new ControllerRegistry(new MachineEventPublisher());

        for (int strike = 1; strike < 4; strike++) {
            assertDoesNotThrow(() -> registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false)));
        }
        assertThrows(
            IllegalStateException.class,
            () -> registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false))
        );
    }

    @Test
    void connectedReadingResetsTheStrikeCounter() {
        ControllerRegistry registry = new ControllerRegistry(new MachineEventPublisher());

        for (int strike = 1; strike < 4; strike++) {
            registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false));
        }
        assertDoesNotThrow(() -> registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", true)));
        for (int strike = 1; strike < 4; strike++) {
            assertDoesNotThrow(() -> registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false)));
        }
    }

    @Test
    void headsMaintainIndependentStrikeCounters() {
        ControllerRegistry registry = new ControllerRegistry(new MachineEventPublisher());

        for (int strike = 1; strike < 4; strike++) {
            registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false));
        }
        for (int strike = 1; strike < 4; strike++) {
            registry.ensureCanContinue("head-2", OPERATION, () -> false, snapshot("head-2", false));
        }
        assertThrows(
            IllegalStateException.class,
            () -> registry.ensureCanContinue("head-1", OPERATION, () -> false, snapshot("head-1", false))
        );
        assertThrows(
            IllegalStateException.class,
            () -> registry.ensureCanContinue("head-2", OPERATION, () -> false, snapshot("head-2", false))
        );
    }

    private MachineStatusSnapshot snapshot(String id, boolean connected) {
        int head = "head-1".equals(id) ? 1 : 2;
        return new MachineStatusSnapshot(
            id, head, connected, null, 0, connected ? "IDLE" : "DISCONNECTED", null,
            null, null, null, null, null, null, null, null, 0, 0, 0, null
        );
    }
}
package com.dmhc.agent.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class PortLeaseBookTest {
    @Test
    void cannotLeaseOnePortToBothControllers() {
        PortLeaseBook leases = new PortLeaseBook();
        leases.acquire("head-1", "COM4");

        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> leases.acquire("head-2", "com4")
        );

        assertEquals("head-1", leases.ownerOf("COM4").orElseThrow());
        assertEquals("Serial port com4 is already in use by head-1.", error.getMessage());
    }

    @Test
    void releasedPortCanBeAssignedToOtherController() {
        PortLeaseBook leases = new PortLeaseBook();
        leases.acquire("head-1", "COM4");
        leases.release("head-1", "COM4");
        leases.acquire("head-2", "COM4");

        assertEquals("head-2", leases.ownerOf("COM4").orElseThrow());
    }

    @Test
    void sameControllerCannotAcquireTheSameLeaseTwice() {
        PortLeaseBook leases = new PortLeaseBook();
        leases.acquire("head-1", "COM4");

        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> leases.acquire("head-1", "COM4")
        );

        assertEquals("head-1", leases.ownerOf("COM4").orElseThrow());
        assertEquals("Serial port COM4 is already reserved by head-1.", error.getMessage());
    }
}
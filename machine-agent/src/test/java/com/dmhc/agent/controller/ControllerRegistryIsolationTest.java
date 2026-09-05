package com.dmhc.agent.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.dmhc.agent.events.MachineEventPublisher;
import org.junit.jupiter.api.Test;

class ControllerRegistryIsolationTest {
    @Test
    void numericAndCanonicalIdsResolveToTwoIndependentSessions() {
        ControllerRegistry registry = new ControllerRegistry(new MachineEventPublisher());

        assertSame(registry.require("head-1"), registry.require("1"));
        assertSame(registry.require("head-2"), registry.require("2"));
        assertNotSame(registry.require("1"), registry.require("2"));
        assertEquals(1, registry.status("1").head());
        assertEquals("head-1", registry.status("1").controllerId());
        assertEquals(2, registry.status("2").head());
        assertEquals("head-2", registry.status("2").controllerId());
    }
}
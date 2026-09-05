package com.dmhc.agent.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Locale;
import org.junit.jupiter.api.Test;

class GrblCommandBuilderTest {
    @Test
    void buildsAsciiGrbl11JogCommandsForEachAxisAndDirection() {
        assertEquals("$J=G21 G91 X100 F1000", GrblCommandBuilder.jog(100, 0, 0, 1000));
        assertEquals("$J=G21 G91 X-100 F1000", GrblCommandBuilder.jog(-100, 0, 0, 1000));
        assertEquals("$J=G21 G91 Y100 F1000", GrblCommandBuilder.jog(0, 100, 0, 1000));
        assertEquals("$J=G21 G91 Y-100 F1000", GrblCommandBuilder.jog(0, -100, 0, 1000));
        assertEquals("$J=G21 G91 Z10 F500", GrblCommandBuilder.jog(0, 0, 10, 500));
        assertEquals("$J=G21 G91 X10.25 F250.5", GrblCommandBuilder.jog(10.25, 0, 0, 250.5));
        assertEquals("$J=G21 G91 Y-0.125 F75.75", GrblCommandBuilder.jog(0, -0.125, 0, 75.75));
        assertEquals("G21 G91 G1 X100 F1000", GrblCommandBuilder.legacyJog(100, 0, 0, 1000));
        assertEquals("G21 G91 G1 X-100 F1000", GrblCommandBuilder.legacyJog(-100, 0, 0, 1000));
        assertEquals("G21 G91 G1 Y100 F1000", GrblCommandBuilder.legacyJog(0, 100, 0, 1000));
        assertEquals("G21 G91 G1 Y-100 F1000", GrblCommandBuilder.legacyJog(0, -100, 0, 1000));
        assertEquals("G21 G91 G1 Z10 F500", GrblCommandBuilder.legacyJog(0, 0, 10, 500));
        assertEquals("G21 G91 G1 Z0.125 F75.75", GrblCommandBuilder.legacyJog(0, 0, 0.125, 75.75));
    }

    @Test
    void rejectsInvalidJogRequests() {
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(0, 0, 0, 100));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(1, 1, 0, 100));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(1, 0, 0, 0));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(Double.NaN, 0, 0, 100));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(Double.POSITIVE_INFINITY, 0, 0, 100));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(1_000_000.1, 0, 0, 100));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.jog(1, 0, 0, Double.POSITIVE_INFINITY));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.legacyJog(0, 0, -1, -25));
    }

    @Test
    void jogCommandsRemainAsciiInvariantUnderDecimalCommaLocales() {
        Locale previous = Locale.getDefault(Locale.Category.FORMAT);
        try {
            Locale.setDefault(Locale.Category.FORMAT, Locale.GERMANY);
            assertEquals("$J=G21 G91 X1.25 F250.5", GrblCommandBuilder.jog(1.25, 0, 0, 250.5));
            assertEquals("G21 G91 G1 Y-1.25 F250.5", GrblCommandBuilder.legacyJog(0, -1.25, 0, 250.5));
        } finally {
            Locale.setDefault(Locale.Category.FORMAT, previous);
        }
    }

    @Test
    void buildsG10L20WorkOffsetsWithoutMotionCommands() {
        assertEquals("G10 L20 P0 X0 Y0 Z0", GrblCommandBuilder.setWorkPosition(0d, 0d, 0d));
        assertEquals("G10 L20 P0 X12.5 Y-3.25", GrblCommandBuilder.setWorkPosition(12.5, -3.25, null));
        assertEquals("G10 L20 P0 Z7", GrblCommandBuilder.setWorkPosition(null, null, 7d));
    }

    @Test
    void rejectsInvalidWorkOffsets() {
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.setWorkPosition(null, null, null));
        assertThrows(IllegalArgumentException.class, () -> GrblCommandBuilder.setWorkPosition(Double.POSITIVE_INFINITY, null, null));
    }
}
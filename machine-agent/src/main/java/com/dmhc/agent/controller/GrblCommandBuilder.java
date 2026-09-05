package com.dmhc.agent.controller;

import java.math.BigDecimal;

/**
 * Produces locale-invariant GRBL 1.1 commands. GRBL accepts ASCII numeric
 * tokens only, so these commands must not use a system-localized formatter.
 */
final class GrblCommandBuilder {
    private static final double MAX_ABSOLUTE_VALUE = 1_000_000d;

    private GrblCommandBuilder() {}

    static String jog(double x, double y, double z, double feedRate) {
        return jogCommand("$J=G21 G91", x, y, z, feedRate);
    }

    static String legacyJog(double x, double y, double z, double feedRate) {
        return jogCommand("G21 G91 G1", x, y, z, feedRate);
    }

    private static String jogCommand(String prefix, double x, double y, double z, double feedRate) {
        validateFinite("X", x);
        validateFinite("Y", y);
        validateFinite("Z", z);
        validateFinite("Feed rate", feedRate);
        if (feedRate <= 0) throw new IllegalArgumentException("Jog feed rate must be greater than zero.");

        int movingAxes = (x != 0 ? 1 : 0) + (y != 0 ? 1 : 0) + (z != 0 ? 1 : 0);
        if (movingAxes != 1) {
            throw new IllegalArgumentException("A jog request must contain exactly one non-zero axis distance.");
        }

        String axis = x != 0 ? "X" + number(x) : y != 0 ? "Y" + number(y) : "Z" + number(z);
        String command = prefix + " " + axis + " F" + number(feedRate);
        if (!command.matches("(?:\\$J=G21 G91|G21 G91 G1) [XYZ]-?[0-9]+(?:\\.[0-9]+)? F[0-9]+(?:\\.[0-9]+)?")) {
            throw new IllegalArgumentException("Unable to construct a valid GRBL jog command.");
        }
        return command;
    }

    static String setWorkPosition(Double x, Double y, Double z) {
        if (x == null && y == null && z == null) {
            throw new IllegalArgumentException("At least one work-coordinate value is required.");
        }
        StringBuilder command = new StringBuilder("G10 L20 P0");
        appendAxis(command, "X", x);
        appendAxis(command, "Y", y);
        appendAxis(command, "Z", z);
        return command.toString();
    }

    private static void appendAxis(StringBuilder command, String axis, Double value) {
        if (value == null) return;
        validateFinite(axis, value);
        command.append(' ').append(axis).append(number(value));
    }

    private static void validateFinite(String label, double value) {
        if (!Double.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_VALUE) {
            throw new IllegalArgumentException(label + " must be a finite value within ±" + (long) MAX_ABSOLUTE_VALUE + ".");
        }
    }

    private static String number(double value) {
        if (value == 0d) return "0";
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }
}
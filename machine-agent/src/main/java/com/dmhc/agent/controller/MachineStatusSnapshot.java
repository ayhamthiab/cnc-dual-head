package com.dmhc.agent.controller;

/** JSON-safe representation of actual UGS status. Null means not reported. */
public record MachineStatusSnapshot(
    String controllerId,
    int head,
    boolean connected,
    String port,
    int baudRate,
    String connection,
    String state,
    PositionDto machinePosition,
    PositionDto workPosition,
    LimitPinsDto limitPins,
    Double feedRate,
    Double spindleSpeed,
    String firmware,
    String alarm,
    String error,
    int rowsSent,
    int rowsCompleted,
    int rowsRemaining,
    String activeCommand
) {
    public static MachineStatusSnapshot disconnected(String id, int head) {
        return new MachineStatusSnapshot(
            id, head, false, null, 0, "disconnected", "DISCONNECTED",
            null, null, null, null, null, null, null, null, 0, 0, 0, null
        );
    }

    public record PositionDto(Double x, Double y, Double z) {}
    public record LimitPinsDto(
        Boolean x, Boolean x0, Boolean x1,
        Boolean y, Boolean y0, Boolean y1,
        Boolean z, Boolean z0, Boolean z1
    ) {}
}
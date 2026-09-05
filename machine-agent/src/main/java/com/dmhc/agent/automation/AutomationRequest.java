package com.dmhc.agent.automation;

public record AutomationRequest(
    String jobId,
    String filename,
    String head1Port,
    String head2Port,
    int baudRate,
    String head1Gcode,
    String head2Gcode,
    String gapFillGcode,
    double head1OffsetX,
    double head1OffsetZ,
    double head2OffsetX,
    double head2OffsetZ
) {
    public AutomationRequest {
        jobId = required(jobId, "jobId");
        filename = required(filename, "filename");
        head1Port = required(head1Port, "head1Port");
        head2Port = required(head2Port, "head2Port");
        head1Gcode = required(head1Gcode, "head1Gcode");
        head2Gcode = required(head2Gcode, "head2Gcode");
        gapFillGcode = required(gapFillGcode, "gapFillGcode");
        if (head1Port.equalsIgnoreCase(head2Port)) {
            throw new IllegalArgumentException("Head 1 and Head 2 must use different serial ports.");
        }
        if (baudRate < 1200 || baudRate > 2_000_000) {
            throw new IllegalArgumentException("Baud rate must be between 1200 and 2000000.");
        }
        finite(head1OffsetX, "head1OffsetX");
        finite(head1OffsetZ, "head1OffsetZ");
        finite(head2OffsetX, "head2OffsetX");
        finite(head2OffsetZ, "head2OffsetZ");
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required.");
        return value;
    }

    private static void finite(double value, String name) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException(name + " must be a finite number.");
    }
}

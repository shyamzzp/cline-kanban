import { describe, expect, it } from "vitest";

import { formatSessionElapsedDuration } from "@/utils/session-timer";

describe("formatSessionElapsedDuration", () => {
	it("formats durations under one hour as mm:ss", () => {
		expect(formatSessionElapsedDuration(0)).toBe("00:00");
		expect(formatSessionElapsedDuration(65_000)).toBe("01:05");
		expect(formatSessionElapsedDuration(3_599_000)).toBe("59:59");
	});

	it("formats durations of one hour or more as h:mm:ss", () => {
		expect(formatSessionElapsedDuration(3_600_000)).toBe("1:00:00");
		expect(formatSessionElapsedDuration(3_726_000)).toBe("1:02:06");
	});

	it("clamps invalid and negative values to zero", () => {
		expect(formatSessionElapsedDuration(-1)).toBe("00:00");
		expect(formatSessionElapsedDuration(Number.NaN)).toBe("00:00");
	});
});

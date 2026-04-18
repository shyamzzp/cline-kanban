export function formatSessionElapsedDuration(durationMs: number): string {
	const normalizedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
	const totalSeconds = Math.floor(normalizedMs / 1000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}

	return `${String(totalMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

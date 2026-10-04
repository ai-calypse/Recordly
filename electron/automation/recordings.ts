import fs from "node:fs/promises";
import path from "node:path";

const MEDIA = /\.(mp4|webm|mov|mkv|gif|recordly)$/i;

export async function listRecordings(dir: string, limit = 50) {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && MEDIA.test(entry.name))
			.map(async (entry) => {
				const file = path.join(dir, entry.name);
				const stat = await fs.stat(file);
				return {
					path: file,
					name: entry.name,
					sizeBytes: stat.size,
					modifiedAt: stat.mtime.toISOString(),
				};
			}),
	);
	return {
		recordings: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit),
	};
}

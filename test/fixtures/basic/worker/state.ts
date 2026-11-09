// module-level state, which a hot update elsewhere keeps but a Worker restart resets
let hits = 0;

export function hit() {
	hits += 1;
	return hits;
}

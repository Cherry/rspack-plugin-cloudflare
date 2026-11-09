declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}

declare module '*.bin' {
	const data: ArrayBuffer;
	export default data;
}

declare module '*.svg' {
	const url: string;
	export default url;
}

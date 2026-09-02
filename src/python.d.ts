/** esbuild inlines `.py` files as strings (see the `text` loader in esbuild.js). */
declare module '*.py' {
	const source: string;
	export default source;
}

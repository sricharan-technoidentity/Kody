// Deferred trusted build tools; authored modules never load the host compiler.
export function importPackageBuildTools() {
	return import('./package-runtime/package-build-tools.ts')
}

export function importPackageTypescript() {
	return import('./package-runtime/package-build-tools.ts')
}

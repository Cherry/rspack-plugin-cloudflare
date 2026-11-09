import { EventEmitter } from 'node:events';
import fsPromises from 'node:fs/promises';

export default {
	fetch() {
		return Response.json({
			// injected as a global by the unenv preset on this compatibility date
			process: typeof process.nextTick,
			// polyfilled by unenv rather than provided by workerd on this date
			fsPromises: typeof fsPromises.readFile,
			// native in workerd under nodejs_compat
			events: typeof EventEmitter,
		});
	},
} satisfies ExportedHandler;

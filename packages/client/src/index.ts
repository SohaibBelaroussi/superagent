/**
 * The data layer the web app and the phone app share (D51): requests and their parsing, query keys and
 * definitions, the live event stream, and the words and tones both show. No React and no DOM: each
 * app passes in what differs (the server's address, `fetch`, how it hears the network come back).
 */
export * from './events';
export * from './format';
export * from './http';
export * from './id';
export * from './live';
export * from './queries';
export * from './sse';
export * from './tasks';
export * from './tones';

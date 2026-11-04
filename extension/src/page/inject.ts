/**
 * Bundled as extract.js and injected into the tab with scripting.executeScript.
 * Exposes one function in the extension's isolated world; the background
 * script calls it next and receives a plain, structured-cloneable result.
 */
import Defuddle from 'defuddle';
import { extractPage, type DefuddleConstructor } from './extract';

(globalThis as { __pigeonExtract?: () => unknown }).__pigeonExtract = () =>
	extractPage(document, Defuddle as unknown as DefuddleConstructor);

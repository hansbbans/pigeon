import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { followInPageLink } from '../src/browser-app-client';

function frame(html: string) {
	const { window } = new JSDOM(`<!doctype html><body>${html}</body>`);
	const scrolled: string[] = [];
	(window.HTMLElement.prototype as any).scrollIntoView = function () { scrolled.push(this.id || this.getAttribute('name')); };
	const click = (selector: string) => {
		const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
		const target = window.document.querySelector(selector)!;
		const handled = followInPageLink(Object.defineProperty(event, 'target', { value: target }));
		return { handled, prevented: event.defaultPrevented };
	};
	return { click, scrolled };
}

test('fragment links scroll to the element by id and never navigate', () => {
	const { click, scrolled } = frame('<p><sup id="fnref:1"><a href="#fn:1"><span id="inner">1</span></a></sup></p><ol><li id="fn:1">Note</li></ol>');
	assert.deepEqual(click('#inner'), { handled: true, prevented: true });
	assert.deepEqual(scrolled, ['fn:1']);
});

test('fragment links fall back to named anchors', () => {
	const { click, scrolled } = frame('<a id="ref" href="#f1n">1</a><a name="f1n">1</a>');
	assert.deepEqual(click('#ref'), { handled: true, prevented: true });
	assert.deepEqual(scrolled, ['f1n']);
});

test('a fragment with no target still does not navigate the frame', () => {
	const { click, scrolled } = frame('<a id="ref" href="#missing">1</a>');
	assert.deepEqual(click('#ref'), { handled: true, prevented: true });
	assert.deepEqual(scrolled, []);
});

test('ordinary links and non-link clicks are left alone', () => {
	const { click } = frame('<a id="ext" href="https://example.com/#x">x</a><p id="text">text</p><a id="bare" href="#">top</a>');
	assert.deepEqual(click('#ext'), { handled: false, prevented: false });
	assert.deepEqual(click('#text'), { handled: false, prevented: false });
	assert.equal(click('#bare').prevented, true, 'bare # must not navigate the srcdoc frame either');
});

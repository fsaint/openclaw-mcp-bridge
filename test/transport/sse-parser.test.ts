/**
 * Comprehensive unit tests for the SSE (Server-Sent Events) stream parser.
 *
 * Covers basic event parsing, multi-line data, line endings, comments,
 * edge cases per the WHATWG HTML spec, streaming chunk boundaries,
 * and stream end behavior.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */

import { describe, it, expect } from "vitest";
import { SSEParser, parseSSEStream } from "../../src/transport/sse-parser.js";
import type { SSEEvent } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a string into an AsyncIterable<Uint8Array> for test input.
 *
 * When `chunkSize` is provided, the string is encoded into UTF-8 bytes
 * and split into chunks of at most `chunkSize` bytes (splitting may occur
 * mid-character for multi-byte sequences). When omitted, the entire string
 * is yielded as a single chunk.
 *
 * @param text - The SSE stream text to convert.
 * @param chunkSize - Optional maximum byte count per chunk.
 * @returns An AsyncIterable that yields Uint8Array chunks.
 */
function stringToStream(
  text: string,
  chunkSize?: number,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);

  return {
    async *[Symbol.asyncIterator]() {
      if (chunkSize === undefined || chunkSize <= 0) {
        yield bytes;
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        yield bytes.slice(offset, offset + chunkSize);
      }
    },
  };
}

/**
 * Collect all events from an async generator into an array.
 *
 * @param gen - The async generator to drain.
 * @returns Array of all yielded SSEEvent objects.
 */
async function collectEvents(
  gen: AsyncGenerator<SSEEvent>,
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/**
 * Parse an SSE text string and return all emitted events.
 *
 * @param text - The SSE stream text.
 * @param chunkSize - Optional chunk size for streaming simulation.
 * @returns Array of parsed SSEEvent objects.
 */
async function parseText(
  text: string,
  chunkSize?: number,
): Promise<SSEEvent[]> {
  const parser = new SSEParser();
  return collectEvents(parser.parse(stringToStream(text, chunkSize)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEParser", () => {
  // -------------------------------------------------------------------------
  // 1. Basic event parsing
  // -------------------------------------------------------------------------

  describe("basic event parsing", () => {
    it("should parse a single event with data field", async () => {
      const events = await parseText("data: hello world\n\n");

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("message");
      expect(events[0].data).toBe("hello world");
    });

    it("should parse an event with custom event type", async () => {
      const events = await parseText("event: custom\ndata: payload\n\n");

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("custom");
      expect(events[0].data).toBe("payload");
    });

    it("should parse an event with id field", async () => {
      const events = await parseText("id: 42\ndata: with-id\n\n");

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("42");
      expect(events[0].data).toBe("with-id");
    });

    it("should parse an event with retry field", async () => {
      const events = await parseText("retry: 5000\ndata: with-retry\n\n");

      expect(events).toHaveLength(1);
      expect(events[0].retry).toBe(5000);
      expect(events[0].data).toBe("with-retry");
    });

    it("should parse an event with all fields (event, data, id, retry)", async () => {
      const text = "event: update\ndata: full-event\nid: 99\nretry: 3000\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("update");
      expect(events[0].data).toBe("full-event");
      expect(events[0].id).toBe("99");
      expect(events[0].retry).toBe(3000);
    });

    it("should parse multiple sequential events", async () => {
      const text = "data: first\n\ndata: second\n\ndata: third\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(3);
      expect(events[0].data).toBe("first");
      expect(events[1].data).toBe("second");
      expect(events[2].data).toBe("third");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Multi-line data
  // -------------------------------------------------------------------------

  describe("multi-line data", () => {
    it("should concatenate multiple data: lines with newlines", async () => {
      const text = "data: line1\ndata: line2\ndata: line3\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("line1\nline2\nline3");
    });

    it("should handle empty data: line producing empty string in concatenation", async () => {
      const text = "data: before\ndata:\ndata: after\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("before\n\nafter");
    });

    it("should handle a single empty data: line", async () => {
      const text = "data:\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Line endings
  // -------------------------------------------------------------------------

  describe("line endings", () => {
    it("should handle \\n line endings", async () => {
      const text = "data: newline\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("newline");
    });

    it("should handle \\r\\n line endings", async () => {
      const text = "data: crlf\r\n\r\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("crlf");
    });

    it("should handle \\r line endings", async () => {
      const text = "data: cr\r\r";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("cr");
    });

    it("should handle mixed line endings in the same stream", async () => {
      const text = "data: mixed1\nevent: ping\r\ndata: mixed2\r\r";
      const events = await parseText(text);

      // The first empty line from \r\r dispatches the accumulated event.
      // "data: mixed1\n" sets data to "mixed1"
      // "event: ping\r\n" sets event type to "ping"
      // "data: mixed2\r" sets data to "mixed1\nmixed2"
      // "\r" (empty line) dispatches
      // Wait — actually \r\r splits into ["data: mixed2", "", ...]
      // Let's trace:
      // After split: ["data: mixed1", "event: ping", "data: mixed2", "", ""]
      // process "data: mixed1" -> dataBuffer = ["mixed1"]
      // process "event: ping" -> eventType = "ping"
      // process "data: mixed2" -> dataBuffer = ["mixed1", "mixed2"]
      // process "" -> dispatch -> event {event: "ping", data: "mixed1\nmixed2"}
      // remaining "" is saved as pending, then at end-of-stream dispatch is called but no data -> nothing
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("ping");
      expect(events[0].data).toBe("mixed1\nmixed2");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Comments
  // -------------------------------------------------------------------------

  describe("comments", () => {
    it("should ignore lines starting with :", async () => {
      const text = ": this is a comment\ndata: real data\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("real data");
    });

    it("should yield nothing from a comment-only stream", async () => {
      const text = ": just a comment\n: another comment\n\n";
      const events = await parseText(text);

      // Empty line dispatches, but data buffer is empty so no event
      expect(events).toHaveLength(0);
    });

    it("should ignore comments interspersed between event fields", async () => {
      const text =
        "event: update\n: ignore me\ndata: payload\n: and me too\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("update");
      expect(events[0].data).toBe("payload");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should use empty lines as event boundaries", async () => {
      const text = "data: first\n\n\n\ndata: second\n\n";
      const events = await parseText(text);

      // First empty line dispatches "first".
      // Second and third empty lines try to dispatch but data buffer is empty, so no event.
      // Then "data: second" followed by empty line dispatches "second".
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe("first");
      expect(events[1].data).toBe("second");
    });

    it("should treat field with no colon as field name with empty value", async () => {
      // "data" with no colon means field="data", value=""
      const text = "data\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("");
    });

    it("should include everything after colon when no space follows", async () => {
      const text = "data:no-space-here\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("no-space-here");
    });

    it("should strip exactly one leading space after colon per spec", async () => {
      const text = "data: one space\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("one space");
    });

    it("should strip only one space (preserve additional spaces)", async () => {
      const text = "data:  two spaces\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      // First space after colon is stripped, second space is kept
      expect(events[0].data).toBe(" two spaces");
    });

    it("should NOT dispatch event with empty data buffer", async () => {
      // Only event type but no data lines
      const text = "event: custom-type\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(0);
    });

    it("should default event type to 'message' when no event: field", async () => {
      const text = "data: default-type\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("message");
    });

    it("should ignore id field containing NULL character (U+0000)", async () => {
      const parser = new SSEParser();
      const text = "id: valid-id\ndata: first\n\nid: bad\0id\ndata: second\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(2);
      // First event has the valid id
      expect(events[0].id).toBe("valid-id");
      // Second event: id with NULL was ignored, so _currentId is undefined
      // but lastEventId is still "valid-id" from the first event
      expect(events[1].id).toBeUndefined();
      // The parser's lastEventId should still be "valid-id"
      expect(parser.lastEventId).toBe("valid-id");
    });

    it("should ignore retry field with non-numeric value", async () => {
      const parser = new SSEParser();
      const text = "retry: abc\ndata: no-retry\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(1);
      expect(events[0].retry).toBeUndefined();
      expect(parser.retryMs).toBeUndefined();
    });

    it("should ignore retry field with negative or floating point value", async () => {
      const parser = new SSEParser();
      const text = "retry: -100\ndata: neg\n\nretry: 3.14\ndata: float\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(2);
      // Neither "-100" nor "3.14" consists of only ASCII digits
      expect(events[0].retry).toBeUndefined();
      expect(events[1].retry).toBeUndefined();
      expect(parser.retryMs).toBeUndefined();
    });

    it("should make lastEventId sticky across events", async () => {
      const parser = new SSEParser();
      const text = "id: sticky-id\ndata: first\n\ndata: second\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(2);
      expect(events[0].id).toBe("sticky-id");
      // Second event has no id: field, so _currentId is undefined
      expect(events[1].id).toBeUndefined();
      // But the parser's lastEventId remains sticky
      expect(parser.lastEventId).toBe("sticky-id");
    });

    it("should make retry sticky across events", async () => {
      const parser = new SSEParser();
      const text = "retry: 2000\ndata: first\n\ndata: second\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(2);
      // retry is included on the first event
      expect(events[0].retry).toBe(2000);
      // retry persists on the parser but the event still carries it
      // because _retryMs is included in every dispatched event
      expect(events[1].retry).toBe(2000);
      expect(parser.retryMs).toBe(2000);
    });

    it("should ignore unknown fields", async () => {
      const text = "foo: bar\ndata: known\n\n";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("known");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Streaming chunks
  // -------------------------------------------------------------------------

  describe("streaming chunks", () => {
    it("should handle data split across multiple chunks (mid-line split)", async () => {
      // "data: hello world\n\n" split into 3-byte chunks
      const text = "data: hello world\n\n";
      const events = await parseText(text, 3);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("hello world");
    });

    it("should handle 1-byte-at-a-time streaming", async () => {
      const text = "event: ping\ndata: byte-by-byte\n\n";
      const events = await parseText(text, 1);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("ping");
      expect(events[0].data).toBe("byte-by-byte");
    });

    it("should handle multiple events split across chunks", async () => {
      const text = "data: one\n\ndata: two\n\ndata: three\n\n";
      const events = await parseText(text, 5);

      expect(events).toHaveLength(3);
      expect(events[0].data).toBe("one");
      expect(events[1].data).toBe("two");
      expect(events[2].data).toBe("three");
    });

    it("should handle very large event data", async () => {
      const largePayload = "x".repeat(100_000);
      const text = `data: ${largePayload}\n\n`;
      const events = await parseText(text, 1024);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe(largePayload);
      expect(events[0].data.length).toBe(100_000);
    });

    it("should handle UTF-8 multi-byte characters split across chunks", async () => {
      // These characters are multi-byte in UTF-8:
      // U+00E9 (e-acute) = 2 bytes: 0xC3 0xA9
      // U+4E16 (CJK) = 3 bytes: 0xE4 0xB8 0x96
      // U+1F600 (emoji) = 4 bytes: 0xF0 0x9F 0x98 0x80
      const text = "data: \u00e9\u4e16\u{1F600}\n\n";
      // Split into 3-byte chunks to guarantee multi-byte chars are split
      const events = await parseText(text, 3);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("\u00e9\u4e16\u{1F600}");
    });

    it("should handle chunk boundary exactly at line ending", async () => {
      // Construct a case where chunk splits right at the newline
      const text = "data: exact\n\n";
      // "data: exact" is 11 bytes, then \n is byte 12, then \n is byte 13
      const events = await parseText(text, 12);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("exact");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Stream end
  // -------------------------------------------------------------------------

  describe("stream end", () => {
    it("should dispatch pending event at stream end (no trailing newlines)", async () => {
      // No trailing \n\n — the stream just ends after the data line
      const text = "data: pending";
      const events = await parseText(text);

      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("pending");
    });

    it("should dispatch pending event at stream end with partial field", async () => {
      // Stream ends with data line and a newline but no empty line
      const text = "data: partial\n";
      const events = await parseText(text);

      // The "data: partial" line is processed (data buffer = ["partial"]).
      // At end-of-stream, pending is empty string (""), so:
      //   remaining = "" and pending = "" -> else branch -> dispatch -> event
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("partial");
    });

    it("should yield nothing from an empty stream", async () => {
      const events = await parseText("");

      expect(events).toHaveLength(0);
    });

    it("should yield nothing from a stream with only newlines", async () => {
      const events = await parseText("\n\n\n");

      // Empty lines dispatch, but data buffer is always empty
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // parseSSEStream convenience function
  // -------------------------------------------------------------------------

  describe("parseSSEStream convenience function", () => {
    it("should work the same as SSEParser.parse", async () => {
      const text = "event: test\ndata: convenience\nid: 1\n\n";
      const stream = stringToStream(text);
      const events: SSEEvent[] = [];

      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("test");
      expect(events[0].data).toBe("convenience");
      expect(events[0].id).toBe("1");
    });
  });

  // -------------------------------------------------------------------------
  // SSEParser stateful properties
  // -------------------------------------------------------------------------

  describe("SSEParser stateful properties", () => {
    it("should expose retryMs as undefined initially", () => {
      const parser = new SSEParser();
      expect(parser.retryMs).toBeUndefined();
    });

    it("should expose lastEventId as empty string initially", () => {
      const parser = new SSEParser();
      expect(parser.lastEventId).toBe("");
    });

    it("should update retryMs after processing a retry field", async () => {
      const parser = new SSEParser();
      const text = "retry: 1500\ndata: test\n\n";
      await collectEvents(parser.parse(stringToStream(text)));

      expect(parser.retryMs).toBe(1500);
    });

    it("should update lastEventId after processing an id field", async () => {
      const parser = new SSEParser();
      const text = "id: event-123\ndata: test\n\n";
      await collectEvents(parser.parse(stringToStream(text)));

      expect(parser.lastEventId).toBe("event-123");
    });

    it("should retain lastEventId across multiple events", async () => {
      const parser = new SSEParser();
      const text =
        "id: first\ndata: a\n\ndata: b\n\nid: third\ndata: c\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(3);
      expect(parser.lastEventId).toBe("third");
    });

    it("should retain retryMs when updated by a later event", async () => {
      const parser = new SSEParser();
      const text = "retry: 1000\ndata: a\n\nretry: 2000\ndata: b\n\n";
      const events = await collectEvents(
        parser.parse(stringToStream(text)),
      );

      expect(events).toHaveLength(2);
      expect(parser.retryMs).toBe(2000);
    });
  });
});

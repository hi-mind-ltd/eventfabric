import { describe, it, expect } from "vitest";
import { matchesTopic, type TopicFilter } from "../src/projections/topic-filter";

describe("TopicFilter", () => {
  describe("matchesTopic", () => {
    it("returns true for 'all' mode regardless of topic", () => {
      const filter: TopicFilter = { mode: "all" };
      expect(matchesTopic(filter, "any-topic")).toBe(true);
      expect(matchesTopic(filter, "another-topic")).toBe(true);
      expect(matchesTopic(filter, null)).toBe(true);
      expect(matchesTopic(filter, "")).toBe(true);
    });

    it("returns true for 'all' mode when filter is undefined", () => {
      expect(matchesTopic(undefined, "any-topic")).toBe(true);
      expect(matchesTopic(undefined, null)).toBe(true);
    });

    it("returns true for 'include' mode when topic is in the list", () => {
      const filter: TopicFilter = { mode: "include", topics: ["user", "order"] };
      expect(matchesTopic(filter, "user")).toBe(true);
      expect(matchesTopic(filter, "order")).toBe(true);
    });

    it("returns false for 'include' mode when topic is not in the list", () => {
      const filter: TopicFilter = { mode: "include", topics: ["user", "order"] };
      expect(matchesTopic(filter, "payment")).toBe(false);
      expect(matchesTopic(filter, "shipping")).toBe(false);
    });

    it("returns false for 'include' mode when topic is null", () => {
      const filter: TopicFilter = { mode: "include", topics: ["user", "order"] };
      expect(matchesTopic(filter, null)).toBe(false);
    });

    it("returns false for 'include' mode when topic is empty string", () => {
      const filter: TopicFilter = { mode: "include", topics: ["user", "order"] };
      expect(matchesTopic(filter, "")).toBe(false);
    });

    it("returns false for 'exclude' mode when topic is in the list", () => {
      const filter: TopicFilter = { mode: "exclude", topics: ["user", "order"] };
      expect(matchesTopic(filter, "user")).toBe(false);
      expect(matchesTopic(filter, "order")).toBe(false);
    });

    it("returns true for 'exclude' mode when topic is not in the list", () => {
      const filter: TopicFilter = { mode: "exclude", topics: ["user", "order"] };
      expect(matchesTopic(filter, "payment")).toBe(true);
      expect(matchesTopic(filter, "shipping")).toBe(true);
    });

    it("returns true for 'exclude' mode when topic is null", () => {
      const filter: TopicFilter = { mode: "exclude", topics: ["user", "order"] };
      expect(matchesTopic(filter, null)).toBe(true);
    });

    it("returns true for 'exclude' mode when topic is empty string", () => {
      const filter: TopicFilter = { mode: "exclude", topics: ["user", "order"] };
      expect(matchesTopic(filter, "")).toBe(true);
    });

    it("handles empty include topics list", () => {
      const filter: TopicFilter = { mode: "include", topics: [] };
      expect(matchesTopic(filter, "any-topic")).toBe(false);
      expect(matchesTopic(filter, null)).toBe(false);
    });

    it("handles empty exclude topics list", () => {
      const filter: TopicFilter = { mode: "exclude", topics: [] };
      expect(matchesTopic(filter, "any-topic")).toBe(true);
      expect(matchesTopic(filter, null)).toBe(true);
    });

    it("handles single topic in include list", () => {
      const filter: TopicFilter = { mode: "include", topics: ["user"] };
      expect(matchesTopic(filter, "user")).toBe(true);
      expect(matchesTopic(filter, "order")).toBe(false);
    });

    it("handles single topic in exclude list", () => {
      const filter: TopicFilter = { mode: "exclude", topics: ["user"] };
      expect(matchesTopic(filter, "user")).toBe(false);
      expect(matchesTopic(filter, "order")).toBe(true);
    });

    it("handles multiple topics in include list", () => {
      const filter: TopicFilter = { mode: "include", topics: ["user", "order", "payment"] };
      expect(matchesTopic(filter, "user")).toBe(true);
      expect(matchesTopic(filter, "order")).toBe(true);
      expect(matchesTopic(filter, "payment")).toBe(true);
      expect(matchesTopic(filter, "shipping")).toBe(false);
    });

    it("handles multiple topics in exclude list", () => {
      const filter: TopicFilter = { mode: "exclude", topics: ["user", "order", "payment"] };
      expect(matchesTopic(filter, "user")).toBe(false);
      expect(matchesTopic(filter, "order")).toBe(false);
      expect(matchesTopic(filter, "payment")).toBe(false);
      expect(matchesTopic(filter, "shipping")).toBe(true);
    });

    it("is case-sensitive for topic matching", () => {
      const filter: TopicFilter = { mode: "include", topics: ["User"] };
      expect(matchesTopic(filter, "User")).toBe(true);
      expect(matchesTopic(filter, "user")).toBe(false);
    });
  });
});


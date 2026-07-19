import { describe, expect, it } from "vitest";
import { contentTypeFor } from "../src/server.js";

describe("contentTypeFor", () => {
  it("maps known extensions", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("app.css")).toContain("text/css");
    expect(contentTypeFor("app.js")).toContain("text/javascript");
  });
  it("defaults to octet-stream", () => {
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
  });
});

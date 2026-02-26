import { describe, expect, test } from "bun:test";
import { rootDomain } from "../src/utils/text";

describe("rootDomain", () => {
  test("keeps standard registrable domain", () => {
    expect(rootDomain("billing@sub.netflix.com")).toBe("netflix.com");
  });

  test("keeps registrable domain for common second-level ccTLD", () => {
    expect(rootDomain("orders@payments.amazon.co.uk")).toBe("amazon.co.uk");
    expect(rootDomain("mailer.shop.com.au")).toBe("shop.com.au");
  });

  test("preserves ip-like hosts", () => {
    expect(rootDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});

import { describe, it, expect, vi } from "vitest";
import { buildCsv, downloadCsv } from "../csv";

describe("buildCsv", () => {
  it("builds basic CSV with headers and rows", () => {
    expect(buildCsv(["A", "B"], [["1", "2"], ["3", "4"]])).toBe(
      "A,B\r\n1,2\r\n3,4\r\n"
    );
  });

  it("quotes fields containing commas", () => {
    expect(buildCsv(["Name"], [["Smith, John"]])).toBe(
      'Name\r\n"Smith, John"\r\n'
    );
  });

  it("escapes double quotes by doubling them", () => {
    expect(buildCsv(["Note"], [['He said "hi"']])).toBe(
      'Note\r\n"He said ""hi"""\r\n'
    );
  });

  it("quotes fields containing newlines", () => {
    expect(buildCsv(["Note"], [["line1\nline2"]])).toBe(
      'Note\r\n"line1\nline2"\r\n'
    );
  });

  it("handles empty rows", () => {
    expect(buildCsv(["A"], [])).toBe("A\r\n");
  });

  it("handles empty headers", () => {
    expect(buildCsv([], [["1"]])).toBe("\r\n1\r\n");
  });
});

describe("downloadCsv", () => {
  it("creates a blob URL, triggers a click, and revokes the URL", () => {
    const mockClick = vi.fn();
    const mockAnchor = {
      href: "",
      download: "",
      click: mockClick,
    } as unknown as HTMLAnchorElement;

    vi.spyOn(document, "createElement").mockReturnValue(mockAnchor);

    const fakeUrl = "blob:http://localhost/fake-uuid";
    const createObjectURL = vi.fn().mockReturnValue(fakeUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    vi.useFakeTimers();
    downloadCsv("A,B\r\n1,2\r\n", "test.csv");

    expect(document.createElement).toHaveBeenCalledWith("a");
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob: Blob = createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/csv;charset=utf-8;");
    expect(mockAnchor.href).toBe(fakeUrl);
    expect(mockAnchor.download).toBe("test.csv");
    expect(mockClick).toHaveBeenCalledOnce();

    // revokeObjectURL is deferred to allow browser to initiate download
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(revokeObjectURL).toHaveBeenCalledWith(fakeUrl);

    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

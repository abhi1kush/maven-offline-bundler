import { describe, expect, it } from "vitest";
import { SPRING_BOOT_EXAMPLE } from "../examplePom";
import { pomIdentity, validatePom } from "./pom";

describe("validatePom", () => {
  it("reads the Spring Boot example", () => {
    const result = validatePom(SPRING_BOOT_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coordinates.gav).toBe("com.example:hello-offline:0.0.1-SNAPSHOT");
    expect(result.problems).toEqual([]);
    expect(pomIdentity(SPRING_BOOT_EXAMPLE)).toEqual({
      groupId: "com.example",
      artifactId: "hello-offline",
      version: "0.0.1-SNAPSHOT",
      parent: {
        groupId: "org.springframework.boot",
        artifactId: "spring-boot-starter-parent",
        version: "3.3.13",
      },
      dependencies: [
        {
          groupId: "org.springframework.boot",
          artifactId: "spring-boot-starter-web",
          version: "",
        },
      ],
      plugins: [
        {
          groupId: "org.springframework.boot",
          artifactId: "spring-boot-maven-plugin",
          version: "",
        },
      ],
      properties: { "java.version": "17" },
    });
  });

  it("accepts a namespaced artifactId", () => {
    const pom = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <artifactId>hello-offline</artifactId>
  <groupId>com.example</groupId>
  <version>1.0</version>
</project>`;
    const result = validatePom(pom);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.coordinates.gav).toBe("com.example:hello-offline:1.0");
  });

  it("points at the broken line of an invalid pom", () => {
    const pom = "<project>\n  <version>1.0\n</project>";
    const result = validatePom(pom);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not valid XML");
    expect(result.problems[0]?.line).toBeGreaterThan(0);
  });

  it("points at the project when artifactId is missing", () => {
    const result = validatePom("<project>\n  <groupId>com.example</groupId>\n</project>");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("<artifactId>");
    expect(result.problems[0]?.line).toBe(1);
  });
});

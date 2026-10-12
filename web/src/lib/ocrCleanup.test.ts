import { describe, expect, it } from "vitest";
import { SPRING_BOOT_EXAMPLE } from "../examplePom";
import { pomIdentity } from "./pom";
import { cleanupOcrParts, cleanupOcrText, stripEditorLineNumbers, tagKeyCollisions } from "./ocrCleanup";

const BROKEN = `pom.xml
1 «?xml version=“1.O” encoding=“UTF-8”?»
2 <project xmlns=“http://maven.apache.0rg/POM/4.O.O”
3          xmlns:xs1=“http://www.w3.org/2001/XMLSchema-instance”
4          xs1:schemalocatlon=“http://maven.apache.org/POM/4.O.O https://maven.apache.org/xsd/maven-4.O.O.xsd”>
5   <mode1Version>4.O.O</mode1Version>
5   <parent>
6     <groupld>0rg.springframework.boot</groupld>
7     <artifactld>spring-boot-starter-parent</artifactld>
8     <version>3.3.l3</version>
9     <relativePath/>
10  </parent>
11  <groupId>c0m.example</groupId>
12  <artifactld>hello-offline</artifactld>
13  <version>O.O.1-SNAPSHOT</version>
14  <name>hello-offline</name>
15  <description>Minimal Spring Boot 3.3 web application</description>
16  <properties>
17    <java.versi0n>l7</java.versi0n>
18  </properties>
19  <dependencies>
20    <dependency>
21      <groupId>0rg.springframework.boot</groupId>
22      <artifactId>spring-boot-starter-web</artifactId>
23    </dependency>
24  </dependencies>
25  <build>
26    <plugins>
27      <plugin>
28        <groupId>org.springframework.boot</groupId>
29        <artifactId>spring-boot-maven-plugin</artifactId>
30      </plugin>
31    </plugins>
32  </build>
33 </project>
Ln 33, Col 10`;

describe("cleanupOcrText", () => {
  it("leaves a real pom unchanged except surrounding whitespace", () => {
    expect(tagKeyCollisions()).toEqual([]);
    expect(cleanupOcrText(SPRING_BOOT_EXAMPLE)).toBe(SPRING_BOOT_EXAMPLE.trim());
    expect(cleanupOcrText(cleanupOcrText(BROKEN))).toBe(cleanupOcrText(BROKEN));
  });

  it("repairs quotes, brackets, tag spellings, versions, and editor chrome", () => {
    const cleaned = cleanupOcrText(BROKEN);
    expect(cleaned.startsWith("<?xml")).toBe(true);
    expect(cleaned).not.toMatch(/^\s*\d+\s/m);
    expect(cleaned).not.toContain("pom.xml");
    expect(cleaned).not.toContain("Ln ");
    expect(pomIdentity(cleaned), cleaned).toEqual(pomIdentity(SPRING_BOOT_EXAMPLE));
  });

  it("strips line numbers only when they look like a gutter", () => {
    const numbered = ["1 <project>", "2   <artifactId>demo</artifactId>", "3   <version>1.O</version>", "4 </project>"].join(
      "\n",
    );
    expect(stripEditorLineNumbers(numbered)).toBe(
      ["<project>", "  <artifactId>demo</artifactId>", "  <version>1.O</version>", "</project>"].join("\n"),
    );
    expect(stripEditorLineNumbers(SPRING_BOOT_EXAMPLE)).toBe(SPRING_BOOT_EXAMPLE);
  });

  it("strips a jammed line number and a pipe gutter", () => {
    const text = ["1|<project>", "2|<artifactId>demo</artifactId>", "3|<groupId>com.example</groupId>", "4|</project>"].join(
      "\n",
    );
    expect(cleanupOcrText(text)).toContain("<artifactId>demo</artifactId>");
    expect(cleanupOcrText(text)).not.toMatch(/^\d+\|/m);
    const jammed = ["12<project>", "13<artifactId>demo</artifactId>", "14</project>"].join("\n");
    expect(stripEditorLineNumbers(jammed)).toBe(["<project>", "<artifactId>demo</artifactId>", "</project>"].join("\n"));
  });

  it("fixes a missing opening bracket and an l read as <", () => {
    const text = ["<project>", "  groupld>com.example</groupId>", "  lartifactId>demo</artifactId>", "  <version>1.0</version>", "</project>"].join(
      "\n",
    );
    const cleaned = cleanupOcrText(text);
    expect(cleaned).toContain("<groupId>com.example</groupId>");
    expect(cleaned).toContain("<artifactId>demo</artifactId>");
  });

  it("repairs an extra l in schemaLocation and a zero inside the POM url", () => {
    const text = [
      "<project xmlns=\"http://maven.apache.org/P0OM/4.0.0\"",
      "         xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
      "         xsi:schemalLocation=\"http://maven.apache.org/P0M/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">",
      "  S   <modelVersion>4.0.0</modelVersion>",
      "  <artifactId>demo</artifactId>",
      "  <version>1.0</version>",
      "</project>",
    ].join("\n");
    const cleaned = cleanupOcrText(text);
    expect(cleaned).toContain("xmlns=\"http://maven.apache.org/POM/4.0.0\"");
    expect(cleaned).toContain("xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\"");
    expect(cleaned).toContain("<modelVersion>4.0.0</modelVersion>");
    expect(cleaned).not.toMatch(/^\s*S\s+<modelVersion>/m);
  });

  it("does not rewrite words outside versions", () => {
    const text = [
      "<project>",
      "  <artifactId>hello-offline</artifactId>",
      "  <version>1.0.0</version>",
      "  <description>Build l for OAuth and log4j</description>",
      "</project>",
    ].join("\n");
    const cleaned = cleanupOcrText(text);
    expect(cleaned).toContain("<artifactId>hello-offline</artifactId>");
    expect(cleaned).toContain("<version>1.0.0</version>");
    expect(cleaned).toContain("Build l for OAuth and log4j");
  });

  it("joins images in order and strips each gutter before combining", () => {
    const first = ["1 <project>", "2   <groupId>com.example</groupId>", "3   <artifactId>hello-offline</artifactId>"].join("\n");
    const second = ["1   <version>O.O.1-SNAPSHOT</version>", "2 </project>"].join("\n");
    const cleaned = cleanupOcrParts([second, first]);
    expect(cleaned.indexOf("<version>")).toBeLessThan(cleaned.indexOf("<artifactId>"));
    const ordered = cleanupOcrParts([first, second]);
    expect(pomIdentity(ordered)).toMatchObject({
      groupId: "com.example",
      artifactId: "hello-offline",
      version: "0.0.1-SNAPSHOT",
    });
  });

  it("turns an escaped screenshot into tags", () => {
    const escaped = [
      "&lt;project&gt;",
      "  &lt;artifactId&gt;demo&lt;/artifactId&gt;",
      "  &lt;version&gt;1.O&lt;/version&gt;",
      "&lt;/project&gt;",
    ].join("\n");
    expect(cleanupOcrText(escaped)).toContain("<version>1.0</version>");
  });
});

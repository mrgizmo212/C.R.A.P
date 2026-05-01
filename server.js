const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, "capture-board.html");
const SUBMISSIONS_DIR = path.join(ROOT, "submissions");

loadDotEnv(path.join(ROOT, ".env"));

const config = {
  host: "127.0.0.1",
  port: Number(process.env.PORT || 8088),
  reviewToken: String(process.env.REVIEW_TOKEN || ""),
  maxBodyBytes: numberEnv("MAX_BODY_BYTES", 80 * 1024 * 1024),
  maxImages: numberEnv("MAX_IMAGES", 200),
  maxImagesPerSection: numberEnv("MAX_IMAGES_PER_SECTION", 4),
  maxImageBytes: numberEnv("MAX_IMAGE_BYTES", 15 * 1024 * 1024),
  aiReportEnabled: process.env.AI_REPORT_ENABLED !== "false",
  aiReportTimeoutMs: numberEnv("AI_REPORT_TIMEOUT_SECONDS", 180) * 1000,
  cursorApiKey: String(process.env.CURSOR_API_KEY || ""),
  cursorModel: String(process.env.QA_CURSOR_MODEL || "composer-2"),
};

function cursorSdkAvailable() {
  try {
    require.resolve("@cursor/sdk");
    return true;
  } catch {
    return false;
  }
}

function cursorAgentStatus() {
  const sdkAvailable = cursorSdkAvailable();
  const configured = Boolean(config.cursorApiKey.trim());
  const enabled = Boolean(config.aiReportEnabled && configured && sdkAvailable);
  const status = enabled ? "enabled" : config.aiReportEnabled ? "fallback" : "disabled";
  let reason = "Cursor SDK reports are configured and ready";
  if (!config.aiReportEnabled) reason = "AI report generation is disabled";
  else if (!configured) reason = "CURSOR_API_KEY is not configured; using fallback report mode";
  else if (!sdkAvailable) reason = "@cursor/sdk is not installed; using fallback report mode";
  return {
    ai_report_enabled: config.aiReportEnabled,
    cursor_sdk_configured: configured,
    cursor_sdk_available: sdkAvailable,
    cursor_agent_enabled: enabled,
    cursor_agent_status: status,
    cursor_agent_reason: reason,
    cursor_model: config.cursorModel,
  };
}

function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function numberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

function safeSlug(value, fallback = "review") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 90)
    .toLowerCase();
  return cleaned || fallback;
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function markdownEscape(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function jsonString(value, maxLength = 20_000) {
  return String(value ?? "").slice(0, maxLength);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, statusCode, message, code = "app_review_error") {
  sendJson(res, statusCode, { ok: false, code, message });
}

async function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES.get(ext) || "application/octet-stream";
  const body = await fsp.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": ext === ".html" ? "no-store" : "private, max-age=60",
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > config.maxBodyBytes) {
      const error = new Error(`Request body exceeds ${config.maxBodyBytes} bytes`);
      error.statusCode = 413;
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    error.statusCode = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeChecks(checks) {
  return Array.isArray(checks)
    ? checks.slice(0, 100).map((check) => ({
        text: jsonString(isObject(check) ? check.text : "", 1000),
        checked: Boolean(isObject(check) && check.checked),
      }))
    : [];
}

function normalizeScreenshot(screenshot) {
  if (!isObject(screenshot)) throw badRequest("Screenshot must be an object", "invalid_screenshot");
  const mime = jsonString(screenshot.mime || "image/png", 80);
  if (!MIME_EXTENSIONS.has(mime)) {
    throw badRequest(`Unsupported screenshot type: ${mime}`, "unsupported_image");
  }
  const dataBase64 = jsonString(screenshot.dataBase64 || screenshot.data_base64 || "", config.maxImageBytes * 2);
  if (!dataBase64) throw badRequest("Screenshot data is required", "missing_image_data");
  return {
    section: jsonString(screenshot.section || "", 200),
    name: jsonString(screenshot.name || "screenshot", 180),
    mime,
    note: jsonString(screenshot.note || "", 5000),
    dataBase64,
  };
}

function normalizeSection(section, index) {
  if (!isObject(section)) throw badRequest(`Section ${index + 1} must be an object`, "invalid_section");
  const screenshots = Array.isArray(section.screenshots)
    ? section.screenshots.map(normalizeScreenshot)
    : [];
  if (screenshots.length > config.maxImagesPerSection) {
    throw badRequest(`Each section supports up to ${config.maxImagesPerSection} screenshots`, "too_many_section_images");
  }
  return {
    title: jsonString(section.title || `Section ${index + 1}`, 200),
    prompt: jsonString(section.prompt || "", 8000),
    notes: jsonString(section.notes || "", 20_000),
    checks: normalizeChecks(section.checks),
    screenshots,
  };
}

function normalizeSubmission(input) {
  if (!isObject(input)) throw badRequest("Submission must be a JSON object", "invalid_submission");
  if (config.reviewToken) {
    const received = String(input.token || "");
    const expected = Buffer.from(config.reviewToken);
    const actual = Buffer.from(received);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw forbidden("Invalid review token", "invalid_token");
    }
  }
  const sections = Array.isArray(input.sections)
    ? input.sections.slice(0, 100).map(normalizeSection)
    : [];
  const screenshotCount = sections.reduce((sum, section) => sum + section.screenshots.length, 0);
  if (screenshotCount > config.maxImages) {
    throw badRequest(`Submission supports up to ${config.maxImages} screenshots`, "too_many_images");
  }
  return {
    artifact: jsonString(input.artifact || "codebase-review", 120),
    metadata: isObject(input.metadata) ? cleanStringMap(input.metadata, 2000) : {},
    sections,
    final: isObject(input.final) ? cleanAnyMap(input.final, 20_000) : {},
    markdown: jsonString(input.markdown || "", 500_000),
  };
}

function cleanStringMap(input, maxValueLength) {
  const output = {};
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    output[jsonString(key, 120)] = jsonString(value, maxValueLength);
  }
  return output;
}

function cleanAnyMap(input, maxValueLength) {
  const output = {};
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    output[jsonString(key, 120)] = typeof value === "string" ? jsonString(value, maxValueLength) : value;
  }
  return output;
}

function badRequest(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function forbidden(message, code) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  return error;
}

function decodeImage(screenshot) {
  const raw = screenshot.dataBase64.includes(",")
    ? screenshot.dataBase64.split(",").pop()
    : screenshot.dataBase64;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw badRequest("Screenshot data is not valid base64", "invalid_image_data");
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length > config.maxImageBytes) {
    throw badRequest("Screenshot exceeds the configured size limit", "image_too_large");
  }
  return buffer;
}

function sectionMarkdown(section, screenshotPaths) {
  const lines = [`## ${section.title || "Untitled Section"}`, ""];
  if (section.prompt.trim()) {
    lines.push("Selected component / element metadata:", "", "```text", section.prompt.trim(), "```", "");
  }
  if (section.checks.length) {
    for (const check of section.checks) lines.push(`- [${check.checked ? "x" : " "}] ${check.text}`);
    lines.push("");
  }
  if (section.notes.trim()) lines.push("Notes:", "", section.notes.trim(), "");
  for (const item of screenshotPaths) {
    lines.push(`![${section.title}](${item.path})`);
    if (item.note.trim()) lines.push("", `Screenshot note: ${item.note.trim()}`);
    lines.push("");
  }
  return lines;
}

function buildCursorPrompt({ submissionId, folder, payload, savedImages, summaryPath, manifestPath, aiReport }) {
  const metadata = payload.metadata || {};
  const final = payload.final || {};
  const sectionCount = Array.isArray(payload.sections) ? payload.sections.length : 0;
  const screenshotCount = Array.isArray(payload.screenshots) ? payload.screenshots.length : savedImages;
  const site = metadata.Site || metadata.URL || metadata.Url || "unknown";
  const tester = metadata.Tester || metadata.Reviewer || "unknown";
  const result = final["Overall result"] || final.result || "not set";
  const topIssues = String(final["Top issues found"] || "").trim() || "not provided";
  const aiLine = aiReport
    ? `- AI report: ${path.join(folder, "ai-report.md")} (${aiReport.mode || "unknown"} mode${aiReport.error ? `, error: ${aiReport.error}` : ""})`
    : "- AI report: not generated";

  return [
    "# Cursor Prompt For Codebase Review Action Planner",
    "",
    "Use this prompt in Cursor after a C.R.A.P. review folder has been saved.",
    "",
    "```text",
    "You are reviewing evidence captured with Codebase Review Action Planner (C.R.A.P.).",
    "Use the look-at-this-crap skill if it is available.",
    "",
    "What happened:",
    `- Tester/reviewer: ${tester}`,
    `- Reviewed site: ${site}`,
    `- Submission id: ${submissionId}`,
    `- Overall result selected by reviewer: ${result}`,
    `- Captured sections: ${sectionCount}`,
    `- Captured screenshots: ${screenshotCount}`,
    `- Top issues entered by reviewer: ${topIssues}`,
    "",
    "Where to find the evidence on this machine:",
    `- Review folder: ${folder}`,
    `- Start here: ${summaryPath}`,
    `- Screenshot manifest: ${manifestPath}`,
    `- Raw structured payload: ${path.join(folder, "payload.json")}`,
    `- Browser Markdown export: ${path.join(folder, "browser-export.md")}`,
    `- Screenshots and annotations: ${path.join(folder, "screenshots")}`,
    aiLine,
    `- This prompt file: ${path.join(folder, "cursor-prompt.md")}`,
    "",
    "Your task:",
    "1. Read summary.md first, then manifest.md, payload.json, ai-report.md if present, and the screenshots folder.",
    "2. Identify the exact issues the reviewer appears to be reporting.",
    "3. Separate proven evidence from inference.",
    "4. Map each issue to likely code areas only when the evidence supports it.",
    "5. Produce an investigation report with reproduction steps, severity, suspected files/components, and a concrete fix plan.",
    "6. Do not edit code unless explicitly asked after the report.",
    "",
    "Return a concise but complete Markdown report.",
    "```",
    "",
  ].join("\n");
}

async function saveReview(submission) {
  const stamp = utcStamp();
  const artifactSlug = safeSlug(submission.artifact, "codebase-review");
  const folder = path.join(SUBMISSIONS_DIR, `${stamp}-${artifactSlug}`);
  const screenshotsDir = path.join(folder, "screenshots");
  await fsp.mkdir(screenshotsDir, { recursive: true });

  const screenshotCount = submission.sections.reduce((sum, section) => sum + section.screenshots.length, 0);
  const summaryLines = [
    "# Codebase Review Action Planner Submission",
    "",
    `- Submitted UTC: ${stamp}`,
    `- Artifact: ${submission.artifact}`,
  ];
  for (const [key, value] of Object.entries(submission.metadata).sort()) {
    summaryLines.push(`- ${key}: ${value}`);
  }
  summaryLines.push("");

  const manifestLines = [
    "# C.R.A.P. Screenshot Manifest",
    "",
    `- Folder: ${folder}`,
    `- Submitted UTC: ${stamp}`,
    `- Total screenshots: ${screenshotCount}`,
    "",
  ];

  const cleanPayload = {
    artifact: submission.artifact,
    metadata: submission.metadata,
    final: submission.final,
    sections: [],
    screenshots: [],
  };

  let savedImages = 0;
  for (const [sectionIndex, section] of submission.sections.entries()) {
    const oneBasedSection = sectionIndex + 1;
    const sectionSlug = safeSlug(section.title, `section-${oneBasedSection}`);
    const sectionPaths = [];
    const cleanSection = {
      title: section.title,
      prompt: section.prompt,
      notes: section.notes,
      checks: section.checks,
      screenshots: [],
    };

    manifestLines.push(`## ${section.title || `Section ${oneBasedSection}`}`, "");
    if (!section.screenshots.length) manifestLines.push("No screenshots saved for this section.", "");

    for (const [screenshotIndex, screenshot] of section.screenshots.entries()) {
      const oneBasedScreenshot = screenshotIndex + 1;
      const imageBytes = decodeImage(screenshot);
      const ext = MIME_EXTENSIONS.get(screenshot.mime);
      const filename = `${String(oneBasedSection).padStart(2, "0")}-${sectionSlug}-${String(oneBasedScreenshot).padStart(2, "0")}${ext}`;
      const relPath = `screenshots/${filename}`;
      const imagePath = path.join(screenshotsDir, filename);
      await fsp.writeFile(imagePath, imageBytes);
      savedImages += 1;

      const imageMeta = {
        section: section.title,
        name: screenshot.name,
        mime: screenshot.mime,
        note: screenshot.note,
        path: relPath,
        bytes: imageBytes.length,
      };
      cleanSection.screenshots.push(imageMeta);
      cleanPayload.screenshots.push(imageMeta);
      sectionPaths.push({ path: relPath, note: screenshot.note });
      manifestLines.push(
        `${oneBasedScreenshot}. \`${relPath}\``,
        `   - Original name: ${screenshot.name}`,
        `   - MIME: ${screenshot.mime}`,
        `   - Bytes: ${imageBytes.length}`,
        `   - Note: ${screenshot.note.trim() || "None"}`,
        "",
      );
    }

    cleanPayload.sections.push(cleanSection);
    summaryLines.push(...sectionMarkdown(section, sectionPaths));
  }

  const drawerNotes = String(submission.final["Live app drawer notes"] || "").trim();
  if (drawerNotes) summaryLines.push("## Live App Drawer Notes", "", drawerNotes, "");
  if (Object.keys(submission.final).length) {
    summaryLines.push("## Final", "", "```json", JSON.stringify(submission.final, null, 2), "```", "");
  }
  if (submission.markdown.trim()) {
    await fsp.writeFile(path.join(folder, "browser-export.md"), submission.markdown, "utf8");
    summaryLines.push("## Browser Markdown Export", "", "See `browser-export.md`.", "");
  }

  const summaryPath = path.join(folder, "summary.md");
  const manifestPath = path.join(folder, "manifest.md");
  await fsp.writeFile(summaryPath, `${summaryLines.join("\n").trimEnd()}\n`, "utf8");
  await fsp.writeFile(manifestPath, `${manifestLines.join("\n").trimEnd()}\n`, "utf8");
  await fsp.writeFile(path.join(folder, "payload.json"), `${JSON.stringify(cleanPayload, null, 2)}\n`, "utf8");

  const aiReport = await generateAiReport(folder, cleanPayload);
  if (aiReport) {
    await fsp.appendFile(summaryPath, "\n## AI Review Report\n\nSee `ai-report.md`.\n", "utf8");
  }

  const submissionId = path.basename(folder);
  const cursorPrompt = buildCursorPrompt({
    submissionId,
    folder,
    payload: cleanPayload,
    savedImages,
    summaryPath,
    manifestPath,
    aiReport,
  });
  const cursorPromptPath = path.join(folder, "cursor-prompt.md");
  await fsp.writeFile(cursorPromptPath, cursorPrompt, "utf8");
  await fsp.appendFile(summaryPath, "\n## Cursor Prompt\n\nSee `cursor-prompt.md`.\n", "utf8");

  const response = {
    ok: true,
    submission_id: submissionId,
    folder,
    folder_url: `/submissions/${encodeURIComponent(submissionId)}/`,
    summary: summaryPath,
    summary_url: `/submissions/${encodeURIComponent(submissionId)}/summary.md`,
    manifest: manifestPath,
    manifest_url: `/submissions/${encodeURIComponent(submissionId)}/manifest.md`,
    screenshots: savedImages,
    cursor_prompt: cursorPromptPath,
    cursor_prompt_url: `/submissions/${encodeURIComponent(submissionId)}/cursor-prompt.md`,
    cursor_prompt_text: cursorPrompt,
  };
  if (aiReport) {
    response.ai_report = aiReport.path;
    response.ai_report_url = `/submissions/${encodeURIComponent(submissionId)}/ai-report.md`;
    response.ai_report_mode = aiReport.mode;
    if (aiReport.error) response.ai_report_error = aiReport.error;
    if (aiReport.run_id) response.ai_report_run_id = aiReport.run_id;
    if (aiReport.model) response.ai_report_model = aiReport.model;
    if (aiReport.image_mode) response.ai_report_image_mode = aiReport.image_mode;
  }
  return response;
}

function fallbackReport(payload, reason) {
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const screenshots = Array.isArray(payload.screenshots) ? payload.screenshots : [];
  const issueLines = [];
  for (const [index, section] of sections.entries()) {
    const notes = String(section.notes || "").trim();
    const shotNotes = (section.screenshots || [])
      .filter((shot) => String(shot.note || "").trim())
      .map((shot) => `  - ${shot.path || shot.name}: ${String(shot.note || "").trim()}`);
    if (!notes && !shotNotes.length) continue;
    issueLines.push(`${index + 1}. ${section.title || "Untitled section"}`);
    issueLines.push(`   - Comments: ${notes || "No section comments recorded."}`);
    issueLines.push(...shotNotes, "");
  }
  const componentLines = [];
  for (const [index, section] of sections.entries()) {
    let element = {};
    try {
      const parsed = JSON.parse(String(section.prompt || "{}"));
      element = isObject(parsed) ? parsed : { raw: section.prompt || "" };
    } catch {
      element = { raw: section.prompt || "" };
    }
    componentLines.push(
      `### ${index + 1}. ${section.title || "Untitled section"}`,
      `- Source: ${element.source || "unknown"}`,
      `- URL: ${element.url || "unknown"}`,
      `- Selector/Region: ${element.selector || JSON.stringify(element.rect || "") || "not captured"}`,
      `- Text/Label: ${element.label || element.text || "not captured"}`,
      "",
    );
  }
  return [
    "# AI Review Report",
    "",
    `Mode: local fallback (${reason})`,
    "",
    "## Executive Summary",
    "",
    `Captured ${sections.length} section(s) and ${screenshots.length} screenshot(s). Cursor SDK generation was unavailable, so this deterministic report organizes the saved evidence without blocking the review workflow.`,
    "",
    "## Issue Summary From Notes And Annotations",
    "",
    issueLines.join("\n").trim() || "No reviewer issue notes were recorded yet.",
    "",
    "## Selected Components / Elements",
    "",
    componentLines.join("\n").trim() || "No selected components or regions were captured.",
    "",
    "## Evidence Map",
    "",
    screenshots.length
      ? screenshots.map((shot) => `- ${shot.path}: ${shot.section || "Unsectioned"}${shot.note ? ` — ${shot.note}` : ""}`).join("\n")
      : "No screenshots were saved.",
    "",
    "## Investigation Plan",
    "",
    "1. Review each selected component or box-selection region against the screenshot evidence.",
    "2. Reproduce any section with comments or screenshot notes in the live app.",
    "3. Map selectors, labels, and visible page regions to the project code responsible for that UI.",
    "4. Confirm whether the behavior is UI-only, backend/API-related, auth/session-related, or data/config-related.",
    "5. Patch the smallest responsible code path and rerun the relevant manual capture flow.",
    "",
  ].join("\n");
}

function evidenceMarkdown(payload) {
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const lines = [
    "# Codebase Review Action Planner Evidence",
    "",
    "Metadata:",
    "```json",
    JSON.stringify(payload.metadata || {}, null, 2),
    "```",
    "",
    "Final reviewer fields:",
    "```json",
    JSON.stringify(payload.final || {}, null, 2),
    "```",
    "",
  ];
  for (const [index, section] of sections.entries()) {
    lines.push(`## ${index + 1}. ${section.title || "Untitled section"}`, "");
    if (section.prompt) lines.push("Selected component / element metadata:", "```text", section.prompt, "```", "");
    if (section.notes) lines.push("Reviewer comments:", section.notes, "");
    if (section.checks?.length) {
      lines.push("Checklist:");
      for (const check of section.checks) lines.push(`- [${check.checked ? "x" : " "}] ${check.text}`);
      lines.push("");
    }
    if (section.screenshots?.length) {
      lines.push("Screenshots / annotations:");
      for (const screenshot of section.screenshots) {
        lines.push(`- ${screenshot.path || screenshot.name} (${screenshot.mime || "image"})${screenshot.note ? ` — ${screenshot.note}` : ""}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").slice(0, 48_000);
}

async function collectCursorImages(folder, payload) {
  const screenshots = Array.isArray(payload.screenshots) ? payload.screenshots : [];
  const images = [];
  for (const screenshot of screenshots.slice(0, 8)) {
    if (!screenshot.path || !String(screenshot.mime || "").startsWith("image/")) continue;
    const filePath = path.resolve(folder, screenshot.path);
    if (!filePath.startsWith(path.resolve(folder) + path.sep)) continue;
    try {
      const data = await fsp.readFile(filePath);
      if (data.length > 4_000_000) continue;
      images.push({ data: data.toString("base64"), mimeType: screenshot.mime });
    } catch {
      continue;
    }
  }
  return images;
}

function assistantTextFromConversation(conversation) {
  if (!Array.isArray(conversation)) return "";
  const texts = [];
  for (const turn of conversation) {
    const steps = Array.isArray(turn?.turn?.steps) ? turn.turn.steps : [];
    for (const step of steps) {
      if (step?.type !== "assistantMessage") continue;
      const text = String(step?.message?.text || "").trim();
      if (text) texts.push(text);
    }
  }
  return texts.at(-1) || "";
}

async function markdownFromRun(run, result) {
  const direct = String(result?.result || run?.result || "").trim();
  if (direct) return direct;
  if (!run || (typeof run.supports === "function" && !run.supports("conversation"))) return "";
  try {
    return assistantTextFromConversation(await run.conversation()).trim();
  } catch {
    return "";
  }
}

async function sendAndExtractMarkdown(agent, message) {
  const run = await agent.send(message);
  const result = await run.wait();
  if (result?.status && result.status !== "finished") {
    return { markdown: "", result, status: result.status };
  }
  return {
    markdown: await markdownFromRun(run, result),
    result,
    status: result?.status || "unknown",
  };
}

async function cursorReport(folder, payload) {
  if (!config.cursorApiKey.trim()) {
    return {
      mode: "fallback",
      markdown: fallbackReport(payload, "CURSOR_API_KEY not configured"),
      error: "CURSOR_API_KEY not configured",
    };
  }

  let Agent;
  try {
    ({ Agent } = await import("@cursor/sdk"));
  } catch (error) {
    return {
      mode: "fallback",
      markdown: fallbackReport(payload, `@cursor/sdk unavailable: ${error.message}`),
      error: `@cursor/sdk unavailable: ${error.message}`,
    };
  }

  const prompt = [
    "Generate a concise Markdown investigation report from this app/codebase review capture.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Do not create branches or pull requests.",
    "- Do not run commands or inspect files; use only the evidence in this prompt and attached screenshots.",
    "- Clearly separate proven observations from inferences.",
    "- If a screenshot/annotation implies an issue, describe what the reviewer appears to be pointing at.",
    "- Mention likely code areas only as hypotheses unless directly proven by selector/component metadata.",
    "- Output Markdown only.",
    "",
    "Required sections:",
    "1. Executive Summary",
    "2. Issues And Evidence",
    "3. Selected Components / Elements",
    "4. Screenshot And Annotation Interpretation",
    "5. Likely Root-Cause Areas",
    "6. Recommended Investigation Plan",
    "7. Open Questions",
    "",
    evidenceMarkdown(payload),
  ].join("\n");

  let agent;
  try {
    const images = await collectCursorImages(folder, payload);
    agent = await Agent.create({
      apiKey: config.cursorApiKey,
      model: { id: config.cursorModel },
      local: { cwd: ROOT },
    });
    let imageMode = images.length ? "attached" : "none";
    let attempt = await sendAndExtractMarkdown(agent, images.length ? { text: prompt, images } : prompt);
    if (!attempt.markdown && images.length) {
      imageMode = "text-only-retry";
      attempt = await sendAndExtractMarkdown(
        agent,
        [
          prompt,
          "",
          "Note: The current Cursor SDK local image attachment path did not return assistant text for this run. Use the screenshot file paths, screenshot notes, selected element metadata, and reviewer comments in the evidence above to write the report.",
        ].join("\n"),
      );
    }
    const { markdown, result, status } = attempt;
    if (!markdown) {
      return {
        mode: "fallback",
        markdown: fallbackReport(payload, `Cursor SDK returned an empty result${status ? ` (status=${status})` : ""}`),
        error: `Cursor SDK returned an empty result${status ? ` (status=${status})` : ""}`,
      };
    }
    return {
      mode: "cursor-sdk",
      markdown,
      error: null,
      run_id: result.id,
      model: result.model || null,
      duration_ms: result.durationMs || null,
      image_mode: imageMode,
    };
  } catch (error) {
    const summary = [error?.name, error?.message, error?.code ? `code=${error.code}` : "", error?.status ? `status=${error.status}` : ""]
      .filter(Boolean)
      .join(" ");
    return {
      mode: "fallback",
      markdown: fallbackReport(payload, `Cursor SDK failed: ${summary || "Unknown error"}`),
      error: `Cursor SDK failed: ${summary || "Unknown error"}`,
    };
  } finally {
    agent?.close?.();
  }
}

async function generateAiReport(folder, payload) {
  if (!config.aiReportEnabled) return null;
  const result = await withTimeout(cursorReport(folder, payload), config.aiReportTimeoutMs, {
    mode: "fallback",
    markdown: fallbackReport(payload, "Cursor SDK timed out"),
    error: "Cursor SDK timed out",
  });
  const reportPath = path.join(folder, "ai-report.md");
  await fsp.writeFile(reportPath, `${String(result.markdown || "").trimEnd()}\n`, "utf8");
  const meta = { ...result };
  delete meta.markdown;
  await fsp.writeFile(path.join(folder, "ai-report.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return { path: reportPath, ...meta };
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function handleReviewPost(req, res) {
  const raw = await readJsonBody(req);
  const submission = normalizeSubmission(raw);
  const response = await saveReview(submission);
  sendJson(res, 200, response);
}

async function handleStaticSubmission(req, res, pathname) {
  const relative = decodeURIComponent(pathname.replace(/^\/submissions\/?/, ""));
  const filePath = path.resolve(SUBMISSIONS_DIR, relative || ".");
  const root = path.resolve(SUBMISSIONS_DIR);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    sendError(res, 403, "Path is outside submissions", "invalid_path");
    return;
  }
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) {
    sendError(res, 404, "Submission file not found", "not_found");
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(filePath, { withFileTypes: true });
    const body = entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const name = entry.name + (entry.isDirectory() ? "/" : "");
        const href = path.posix.join(req.url.endsWith("/") ? req.url : `${req.url}/`, encodeURIComponent(entry.name)) + (entry.isDirectory() ? "/" : "");
        return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
      })
      .join("\n");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Submissions</title></head><body><h1>Submissions</h1><ul>${body}</ul></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }
  await sendFile(res, filePath);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/capture-board.html")) {
    await sendFile(res, HTML_FILE);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      app: "codebase-review-action-planner",
      local_only: isLocalHost(config.host),
      authentication: config.reviewToken ? "shared-token-only" : "none",
      warning: config.reviewToken
        ? "REVIEW_TOKEN is a lightweight local gate, not full authentication."
        : "No authentication is enabled. Keep this bound to localhost.",
      submissions_dir: SUBMISSIONS_DIR,
      ...cursorAgentStatus(),
    });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/submissions")) {
    await handleStaticSubmission(req, res, url.pathname);
    return;
  }
  if (req.method === "POST" && (url.pathname === "/api/reviews" || url.pathname === "/v1/qa-artifacts/checklist")) {
    await handleReviewPost(req, res);
    return;
  }
  sendError(res, 404, "Not found", "not_found");
}

async function main() {
  await fsp.mkdir(SUBMISSIONS_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    router(req, res).catch((error) => {
      const status = Number(error.statusCode || 500);
      const code = error.code || "server_error";
      const message = status >= 500 ? "Internal server error" : error.message;
      if (status >= 500) console.error(error);
      sendError(res, status, message, code);
    });
  });
  server.listen(config.port, config.host, () => {
    console.log(`Codebase Review Action Planner listening on http://${config.host}:${config.port}`);
    if (!isLocalHost(config.host)) {
      console.warn("WARNING: C.R.A.P. has no real authentication yet. Keep it bound to 127.0.0.1 for local-only use.");
    }
    if (!config.reviewToken) {
      console.warn("Local-only mode: REVIEW_TOKEN is blank, so saves are unauthenticated.");
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

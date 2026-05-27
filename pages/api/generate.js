import chromium from "@sparticuz/chromium";
import puppeteerCore from "puppeteer-core";
import puppeteer from "puppeteer";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import Handlebars from "handlebars";


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Call GPT with timeout & retries
async function callGPT(promptOrMessages, model = null, maxTokens = 8000, retries = 2, timeoutMs = 180000) {
  const resolvedModel = model || process.env.OPENAI_MODEL || "gpt-5-mini";
  while (retries > 0) {
    try {
      let messages;
      if (typeof promptOrMessages === "string") {
        messages = [{ role: "user", content: promptOrMessages }];
      } else if (Array.isArray(promptOrMessages)) {
        messages = promptOrMessages.map((msg) => ({
          role: msg.role === "system" ? "system" : msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        }));
      } else {
        messages = [{ role: "user", content: String(promptOrMessages) }];
      }

      const response = await Promise.race([
        openai.chat.completions.create({
          model: resolvedModel,
          max_completion_tokens: maxTokens,
          messages,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("OpenAI request timed out")), timeoutMs)
        ),
      ]);
      return response;
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      console.log(`Retrying... (${retries} attempts left)`);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const { profile, jd, template, jobTitle, companyName, returnBase64 } = req.body;

    if (!profile) return res.status(400).send("Profile required");
    if (!jd) return res.status(400).send("Job description required");

    // Default to Resume.html if no template specified
    const templateName = template || "Resume";

    // Load profile JSON
    console.log(`Loading profile: ${profile}`);
    const profilePath = path.join(process.cwd(), "resumes", `${profile}.json`);

    if (!fs.existsSync(profilePath)) {
      return res.status(404).send(`Profile "${profile}" not found`);
    }

    const profileData = JSON.parse(fs.readFileSync(profilePath, "utf-8"));


    // Calculate years of experience
    const calculateYears = (experience) => {
      if (!experience || experience.length === 0) return 0;

      const parseDate = (dateStr) => {
        if (dateStr.toLowerCase() === "present") return new Date();
        return new Date(dateStr);
      };

      const earliest = experience.reduce((min, job) => {
        const date = parseDate(job.start_date);
        return date < min ? date : min;
      }, new Date());

      const years = (new Date() - earliest) / (1000 * 60 * 60 * 24 * 365);
      return Math.round(years);
    };

    const yearsOfExperience = calculateYears(profileData.experience);

    // Build base resume text for the prompt (name, contact, experience, education)
    const baseResume = `
      FULL BASE RESUME JSON:
        ${JSON.stringify(profileData, null, 2)}
    `;

    const resumePromptTemplate = `# SYSTEM ROLE & PRIMARY OBJECTIVE
You are an expert resume strategist and senior technical resume writer.
Your job is to create a JD-tailored SAMPLE resume based on the user's real resume background.
AUTHORITATIVE INSTRUCTION: This prompt is the authoritative instruction set. If any attached report or prior guidance conflicts with this prompt, follow this prompt.

PRIMARY OBJECTIVE:
Create a tailored SAMPLE resume that is:
* sharply aligned to the target JD
* ATS-friendly
* recruiter-friendly for a fast skim
* clear, specific, and easy to understand
* realistic and interview-defensible
* grounded in the user's real companies, career timeline, and seniority
* strong enough to position the user as a credible fit
* clean, concise, and not repetitive

---

# 1. CORE OPERATING MODES & PHILOSOPHY
This is the most important rule. Default to SAMPLE RESUME mode unless the user clearly asks otherwise.

IF IN SAMPLE RESUME MODE, Default:
If the user says “sample resume,” “tailored sample resume,” or similar:
* Do NOT let the original resume’s main tech stack limit the rewrite.
* Use the user’s real companies, real chronology, real approximate seniority, real years of experience, real domains, and real education as the foundation. Keep the companies unchanged.
* Then rebuild the resume from scratch around the target JD’s stack, tools, architecture, responsibilities, and domain expectations.
* You may imagine new projects, systems, initiatives, and bullet content if needed, as long as they plausibly fit the real companies, the user’s seniority, and the likely work those companies would support.
* If necessary, you may imagine projects that better align with the JD as long as they still plausibly fit the real company context.
* You may reshape the technical story substantially in SAMPLE mode, but it must still feel like a believable version of the user’s career.
* Do not invent new employers, degrees, certifications, clearances, or unrelated niche backgrounds.
* Every bullet must remain interview-defensible. The user should be able to explain it naturally in an interview without sounding fake or overclaimed.

IF IN STRICT TAILOR MODE:
If the user says “tailor my resume” and does NOT say sample:
* Stay closer to the original resume claims.
* Reorder, rewrite, tighten, and prioritize.
* Do not heavily reimagine the background.

SOURCE PRIORITY:
Use these sources in this exact order:
1. This prompt
2. The target job description
3. The user’s actual resume
4. Any attached reports or supporting documents

FOUNDATION & GROUNDING RULES:
Anchor the SAMPLE resume to: the real companies, real sequence of roles, real or approximate dates, total years of experience, likely seniority level, and real education.
Do NOT anchor the SAMPLE resume to: exact original bullet wording, original project descriptions, original core stack if JD points elsewhere, or original emphasis areas if they reduce JD fit.

IMAGINATION RULES:
You may imagine: new projects, new systems, new internal platforms, new feature areas, new migration efforts, new architecture responsibilities, new collaboration patterns, new tool usage, and realistic business outcomes.
ONLY IF THEY: fit the company’s business context, years of experience, role level, likely timeline, help satisfy the JD, and remain interview-defensible.
You may NOT imagine: new employers, fake degrees/certifications/security clearances, unrelated industries, or responsibilities that obviously exceed the candidate’s plausible level.

---

# 2. JD COVERAGE & DEPTH RULES
JD COVERAGE RULE:
The tailored SAMPLE resume must cover:
* 100% of the JD’s mandatory requirements
* At least 80% of the JD’s nice-to-have skills, technologies, platforms, methods, or domain signals
* Coverage must be distributed naturally across Summary, Skills, and Experience; supported by concrete and interview-defensible bullets; specific, not vague; and believable. Do not merely mention a requirement in the skills list.

MANDATORY REQUIREMENT DEPTH RULE:
For every major mandatory skill or technology in the JD, do not stop at the surface-level keyword. Go 1 layer deeper into the related tools, frameworks, libraries, platforms, services, or methods that are naturally required by that skill in the context of the JD’s responsibilities. This 1-layer-deeper coverage must be relevant, technically coherent, specific, interview-defensible, and reflected across Skills and Experience.
Examples:
* Python for AI/ML: Support with PyTorch, NumPy, Pandas, scikit-learn, model training, inference pipelines, evaluation workflows, or experiment tracking.
* Python for backend APIs: Support with FastAPI, Flask, async processing, API design, or background workers.
* AWS: Support with Lambda, ECS, S3, RDS, CloudWatch, IAM, or Terraform/CDK.
* React: Support with TypeScript, Next.js, state management, testing tools, design systems, performance optimization, or frontend experimentation tooling.
Do not attach random related tools just because they belong to the same ecosystem.

NICE-TO-HAVE COVERAGE RULE:
* Cover at least 80% when believable and interview-defensible.
* Support each included nice-to-have skill/technology with ONE clear bullet, not many repeated bullets.
* Do not scatter the same nice-to-have skill across multiple bullets unless absolutely necessary.
* Each should be concrete and specific enough to prove the skill naturally. They may appear in Technical Skills but should be supported by a dedicated experience bullet.

EXAMPLE-GROUP RULE FOR NICE-TO-HAVE ITEMS:
If the JD lists a category followed by examples, such as “Feature Flags, e.g. Statsig, Optimizely, LaunchDarkly,” “Cloud Platforms, e.g. AWS, GCP, Azure,” or “Observability tools, e.g. Datadog, New Relic, Grafana”:
* Choose ONE best-fit example from that group unless explicitly requires multiple.
* Include only that chosen example naturally in the Technical Skills section.
* Support that chosen example with one clear experience bullet whenever possible.
* Do not include multiple equivalent tools from the same example group just for keyword stuffing. Pick the example that best fits the JD responsibilities. Use specific names where appropriate.

---

# 3. SECTION ORDER & CONTENT STRUCTURE RULES
SECTION ORDER FOR FINAL PDF CONTENT:
The generated JSON must support this exact resume order:
1. Name
2. Title
3. Contact information
4. Professional Summary
5. Technical Skills
6. Professional Experience
7. Education

HEADINGS, LAYOUT, & CONTACT RULES:
* The final JSON will be rendered into an HTML/PDF template, so do not output Markdown resume sections.
* The name, title, contact information, summary, skills, experience, and education must be cleanly separated in the JSON fields.
* Use reverse-chronological experience order.
* Dates must stay in MM/YYYY – MM/YYYY, Month YYYY – Month YYYY, or Present format consistent with the base resume.
* Contact Rules: Use only real details from the base resume, including city/state, phone, email, LinkedIn, and portfolio if provided.
* Do not invent phone numbers, emails, LinkedIn URLs, portfolios, locations, employers, schools, degrees, or certifications.

---

# 4. SECTION-SPECIFIC GENERATION RULES

PROFESSIONAL SUMMARY RULE:
* Return the summary as an array of 2 to 4 bullet-sentence strings.
* Each summary bullet must be exactly ONE sentence and MUST end with a period.
* Make it keyword-rich, JD-aligned, and specific. Highlight the most important mandatory requirements first.
* Reflect selected nice-to-have items and some 1-layer-deeper related skills where valuable.
* Use exact or near-exact JD language where natural. Keep it concise and recruiter-friendly.
* Use strategic **bolding** for important keywords, tools, technologies, skills, project names, and numbers that improve scan value.
* Absolutely DO NOT use grammatical connector dashes, en-dashes, em-dashes, semicolons, or colons to connect sentences or phrases.
* You can use commas for sentence flow.
* Standard hyphens used in professional terms, technical terms, and compound words such as open-source, full-time, front-end, and go-to-market are acceptable.

TECHNICAL SKILLS RULES:
* Return skills as a JSON object where each key is a clear technical category and each value is an array of skills.
* Organize skills in logical categories when possible. Terms like Additional, Extra, or Nice-to-have are not suitable.
* Use clear categories such as Languages, Backend, Frontend, Databases, Cloud & DevOps, Testing, Observability, Architecture, Security, AI/ML, or Domain.
* Rebuild the skills section around the JD, not around the original resume’s legacy stack.
* Include all mandatory JD skills, technologies, platforms, methods, or domain requirements, plus the relevant 1-layer-deeper supporting tools necessary for the JD’s responsibilities.
* Include at least 80% of the JD’s nice-to-haves.
* For nice-to-have example groups, include only ONE best-fit example.
* Only include skills supported naturally by the experience section or clearly believable for the background.
* Include both full terms and common acronyms where helpful.
* Do not use unsupported keyword stuffing.
* Do not bold individual skills in the skills arrays.

PROFESSIONAL EXPERIENCE RULES:
* Experience must be reverse chronological.
* Latest 2 companies must have 7 to 8 bullets each.
* All other full-time roles must have 5 bullets each.
* Internship roles must have 3 bullets each.
* Rebuild from scratch around plausible work that fits the companies and aligns to the JD.
* Do not treat original bullets or original stack as strict constraints in SAMPLE RESUME mode.
* The first 3 bullets under every non-internship role MUST be the most JD-relevant bullets.
* Mandatory requirements and 1-layer-deeper skills must appear early.
* Nice-to-haves must be woven naturally, with 1 supporting bullet per included skill when possible.
* The first bullet under each non-internship role must explain the main product, platform, system, initiative, or project.
* In that first bullet, bold the project name or project label.
* The first bullet must be ONE clean, natural sentence.
* Do not format the first bullet like “[PROJECT]: Developed...”.
* Write it as a polished sentence, such as “Developed **Project Name**, a ...”.
* It must clearly show what it was, the role, technical context, and why it mattered.
* Internship roles should not include a project-first bullet.
* Intern bullets should be basic, supportive, and grounded in implementation support, bug fixes, testing, documentation, or QA.
* Across the latest 2 companies combined, include 3 or 4 bullets total that demonstrate communication, cross-functional collaboration, problem-solving, mentoring, ownership, technical guidance, or leadership.
* Tie leadership and collaboration bullets to real delivery work.

---

# 5. BULLET STRUCTURE, QUALITY, AND METRICS

BULLET STRUCTURE RULES:
* Every experience bullet must contain at least:
  1. What the user did or delivered.
  2. How they did it, using tools, architecture, workflows, or methods.
  3. Optional business, user, product, or technical outcome.
* Every experience bullet must be instantly understandable to a recruiter.
* Avoid ambiguity, vague shorthand, and category-only descriptions.
* Include concrete mechanisms and named tools where useful.
* Every experience bullet must be exactly ONE sentence and MUST end with a period.
* Absolutely DO NOT use grammatical connector dashes, en-dashes, em-dashes, semicolons, or colons to connect phrases.
* Use commas instead.
* Standard hyphenated professional terms such as open-source, full-time, front-end, and go-to-market are allowed.

BULLET QUALITY RULES:
* Concrete, specific, role-relevant.
* Sound like strong human resume writing, not generic AI phrasing.
* Use active voice.
* Use past tense for past roles and present tense for current roles.
* Avoid vague responsibility-only bullets.
* Avoid empty claims like results-driven, hardworking, or team player.
* Make each role feel distinct.
* Broad mandatory requirements must be supported with deeper technical details.
* Give nice-to-have skills one clear supporting bullet instead of repeating them.

METRICS RULES:
* Only about 50% to 60% of experience bullets should include explicit numbers or percentages.
* Do not put metrics in every bullet.
* About 60% of the metrics used should be percentages.
* The rest should be counts, time reductions, latency changes, scale figures, throughput, user counts, or similar measures.
* Keep metrics realistic, conservative, and varied.
* Some bullets should remain qualitative.
* Avoid repeating the same metric type.
* Avoid vague claims like “improved efficiency significantly.”
* Possible impact types include performance, latency, throughput, reliability, availability, release speed, error reduction, onboarding speed, support reduction, workflow time, completion rate, adoption, activation, data quality, processing accuracy, and operational visibility.

ANTI-REPETITION & STYLE RULES:
* Vary bullet starters and strong action verbs.
* Avoid repetitive sentence structure, business context repetition, or identical impact framing.
* Do not make bullets feel templated.
* Use concise, direct, senior-level resume language.
* Sound confident but believable.
* Avoid buzzword soup.
* Prefer practical engineering and product language.

BOLDING RULES:
Use strategic **bolding** to improve scan value.
Bold selectively for:
* the title under the name if included in title text
* important keywords in the summary
* key technologies, frameworks, platforms, architecture terms, domain terms, and core skills
* important numbers, metrics, and outcome phrases
* project names in the first bullet of every non-internship role
* selected skills, tools, systems, or outcomes that should stand out quickly
Do not over-bold to the point of noise.

---

# 6. OUTPUT FORMAT RULES
* Output ONLY a single valid JSON object.
* Do NOT output Markdown resume text.
* Do NOT wrap the JSON in a code block.
* Do NOT include commentary, notes, explanations, warnings, or any text outside the JSON object.
* Do NOT output a <thinking> block.
* The JSON object will be passed into an HTML resume template and rendered as a PDF.
* Preserve the resume structure needed for PDF rendering.
* Keep all resume content ATS-friendly, recruiter-friendly, and easy to skim.
* Use **bold markdown** inside string values where useful because the application will convert **bold** to HTML strong tags.
* The summary field MUST be an array of 2 to 4 bullet-sentence strings.
* The experience details field MUST be an array of bullet-sentence strings.
* The skills field MUST be an object of category arrays.
* Preserve real candidate contact information from the base resume, including LinkedIn URL if provided.
* Preserve all real company names, role sequence, dates, locations, and education from the base resume unless the base resume itself contains missing optional fields.
* Do not invent new employers, schools, degrees, certifications, emails, phone numbers, LinkedIn URLs, or portfolio URLs.

Return the final tailored resume using this exact JSON structure:

{
  "name": "<candidate name>",
  "title": "<tailored title aligned to JD>",
  "email": "<email>",
  "phone": "<phone>",
  "location": "<location>",
  "linkedin": "<linkedin or empty string>",
  "website": "<website or empty string>",
  "summary": [
    "<summary bullet 1 with **bold** where useful>",
    "<summary bullet 2 with **bold** where useful>",
    "<summary bullet 3 with **bold** where useful>"
  ],
  "skills": {
    "<CategoryName>": ["skill1", "skill2", "skill3"]
  },
  "experience": [
    {
      "company": "<company name>",
      "title": "<job title>",
      "location": "<location>",
      "start_date": "<start date>",
      "end_date": "<end date>",
      "details": [
        "<bullet 1 with **bold** where useful>",
        "<bullet 2 with **bold** where useful>"
      ]
    }
  ],
  "education": [
    {
      "degree": "<degree>",
      "school": "<school>",
      "start_year": "<start year>",
      "end_year": "<end year>"
    }
  ]
}

---

# 7. EXECUTION PROTOCOL: TAILORING PROCESS & QUALITY CHECK

STEP 1: INTERNAL TAILORING PROCESS:
Before writing the final JSON, internally analyze the following:
* the 5 to 8 most important priorities in the JD
* all mandatory requirements in the JD
* all nice-to-have requirements in the JD
* the specific tools, platforms, methods, and architecture patterns named in the JD
* the 1-layer-deeper related skills needed to support each major mandatory requirement, and which are relevant to responsibilities
* which nice-to-have categories are example groups and which single example best fits each one
* the user’s real companies, timeline, and likely scope, and which plausible projects/systems could exist to support JD requirements
* how to distribute the JD requirements naturally, which nice-to-have skills get their own single bullet, and how to ensure interview-defensibility.

Do not output this analysis. Output only the final JSON object.

STEP 2: FINAL QUALITY CHECK BEFORE OUTPUT:
Before returning the JSON, verify internally that:
* the title is tailored to the JD
* the summary is tailored to the JD and written as 2 to 4 bullet-sentence strings
* the top third of the resume contains the most important JD keywords
* the JSON structure is exactly correct
* 100% of the JD’s mandatory requirements are represented naturally across skills and experience
* major mandatory requirements are supported 1 layer deeper with the relevant related tools/methods
* at least 80% of the JD’s nice-to-have skills or technologies are represented naturally
* each included nice-to-have skill is supported by one clear bullet whenever possible
* nice-to-have example groups use only one best-fit example unless JD expects more
* mandatory and nice-to-have items are supported by concrete, interview-defensible bullets
* the skills section is rebuilt around the JD rather than the original resume’s main stack
* the experience section is rebuilt from scratch around plausible projects and responsibilities that fit the real companies
* the latest 2 companies have 7 to 8 bullets each
* all other full-time companies have 5 bullets each
* internship roles have 3 bullets each
* the first bullet under each non-internship role explains the main project in one clean sentence and bolds the project name
* internship roles do not force a project-first bullet
* the first 3 bullets under every non-internship role are JD-aligned
* 3 or 4 bullets across the latest 2 companies demonstrate communication, problem-solving, mentoring, leadership, or ownership
* every summary bullet and experience bullet is exactly ONE sentence and ends with a period
* no summary bullet or experience bullet uses connector dashes, semicolons, or colons to connect phrases
* standard hyphenated terms like open-source, full-time, front-end, and go-to-market are allowed
* only about 50% to 60% of experience bullets contain explicit metrics
* metrics are realistic and varied
* bullets are specific and unambiguous
* named tools or methods are used where the JD calls for them
* the resume is grounded in the real companies and timeline
* the final result is fully interview-defensible
* the final output is only a single valid JSON object

Here is the full base resume JSON:

\${baseResume}

Here is the target job description:

\${jobDescription}`;

    const prompt = resumePromptTemplate
      .replace(/\$\{baseResume\}/g, baseResume)
      .replace(/\$\{jobDescription\}/g, jd);

    const aiResponse = await callGPT(prompt);

    const finishReason = aiResponse.choices?.[0]?.finish_reason;
    const contentRaw = aiResponse.choices?.[0]?.message?.content ?? "";

    console.log("OpenAI API Response Metadata:");
    console.log("- Model:", aiResponse.model);
    console.log("- Finish reason:", finishReason);
    console.log("- Input tokens:", aiResponse.usage?.prompt_tokens);
    console.log("- Output tokens:", aiResponse.usage?.completion_tokens);

    let content;
    if (finishReason === "length") {
      console.error("⚠️ WARNING: GPT hit max_tokens limit! Response was truncated.");
      console.log("🔄 Retrying with reduced requirements to fit in token limit...");

      const concisePrompt = prompt
        .replace(/8–10 bullets per role/g, "6–8 bullets per role")
        .replace(/NEVER fewer than 8 bullets per role/g, "NEVER fewer than 6 bullets per role");

      const retryResponse = await callGPT(concisePrompt, null, 10000);
      console.log("Retry Response Metadata:");
      console.log("- Finish reason:", retryResponse.choices?.[0]?.finish_reason);
      console.log("- Output tokens:", retryResponse.usage?.completion_tokens);

      content = (retryResponse.choices?.[0]?.message?.content ?? "").trim();
    } else {
      content = contentRaw.trim();
    }

    // Check if AI is apologizing instead of returning JSON
    if (content.toLowerCase().startsWith("i'm sorry") ||
      content.toLowerCase().startsWith("i cannot") ||
      content.toLowerCase().startsWith("i apologize")) {
      console.error("AI is apologizing instead of returning JSON:", content.substring(0, 200));
      throw new Error("AI refused to generate resume. The prompt may be too complex. Please try again with a shorter job description or simpler requirements.");
    }

    // Enhanced JSON extraction - handle various formats
    // Remove markdown code blocks (case insensitive)
    content = content.replace(/```json\s*/gi, "");
    content = content.replace(/```javascript\s*/gi, "");
    content = content.replace(/```\s*/g, "");

    // Remove common prefixes
    content = content.replace(/^(here is|here's|this is|the json is):?\s*/gi, "");

    // Try to extract JSON from text if wrapped
    // Look for content between first { and last }
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      content = content.substring(firstBrace, lastBrace + 1);
    } else {
      console.error("No JSON object found in response");
      throw new Error("AI did not return valid JSON format. Please try again.");
    }

    content = content.trim();

    // Parse JSON with better error handling
    let resumeContent;
    try {
      resumeContent = JSON.parse(content);
    } catch (parseError) {
      console.error("=== JSON PARSE ERROR ===");
      console.error("Parse error:", parseError.message);
      console.error("Content length:", content.length);
      console.error("First 1000 chars:", content.substring(0, 1000));
      console.error("Last 500 chars:", content.substring(Math.max(0, content.length - 500)));

      // Try to fix common JSON issues
      try {
        // Remove trailing commas
        let fixedContent = content.replace(/,(\s*[}\]])/g, '$1');
        // Fix unescaped quotes in strings (basic attempt)
        fixedContent = fixedContent.replace(/([^\\])"([^",:}\]]*)":/g, '$1\\"$2":');
        resumeContent = JSON.parse(fixedContent);
        console.log("✅ Successfully parsed after fixing common issues");
      } catch (secondError) {
        console.error("Failed to parse even after fixes");
        throw new Error(`AI returned invalid JSON: ${parseError.message}. Please try again.`);
      }
    }

    // Validate required fields
    if (!resumeContent.title || !resumeContent.summary || !resumeContent.skills || !resumeContent.experience) {
      console.error("Missing required fields in AI response:", Object.keys(resumeContent));
      throw new Error("AI response missing required fields (title, summary, skills, or experience)");
    }

    // Title: display only the job title, not "Title at Company"
    if (typeof resumeContent.title === "string") {
      resumeContent.title = resumeContent.title
        .replace(/\s+at\s+.*$/i, "")      // remove " at Company"
        .replace(/\*\*([^*]+)\*\*/g, "$1") // remove **bold**
        .replace(/\*/g, "")               // remove any leftover *
        .trim();
    }

    // Summary: if experience > 10 years, show only "more than 10 years", never exact number (12+, 13+, etc.)
    const boldToStrong = (s) =>
      typeof s === "string"
        ? s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        : s;

    // Normalize summary because the new prompt returns summary as bullet sentences
    const normalizeSummaryToBullets = (summary) => {
      if (Array.isArray(summary)) {
        return summary
          .filter(Boolean)
          .map((item) => String(item).trim())
          .filter(Boolean);
      }

      if (typeof summary === "string") {
        return summary
          .split(/\n+/)
          .map((item) => item.replace(/^[-•*]\s*/, "").trim())
          .filter(Boolean);
      }

      return [];
    };

    let summaryBullets = normalizeSummaryToBullets(resumeContent.summary);

    // Summary: if experience > 10 years, show only "more than 10 years"
    if (yearsOfExperience > 10) {
      summaryBullets = summaryBullets.map((bullet) =>
        bullet
          .replace(/\b(1[2-9]|[2-9]\d|\d{3})\s*\+\s*years?\b/gi, "more than 10 years")
          .replace(/\b(1[2-9]|[2-9]\d|\d{3})\s*years?\b/gi, "more than 10 years")
      );
    }

    // Ensure every summary bullet ends with punctuation
    summaryBullets = summaryBullets.map((bullet) => {
      const cleaned = bullet.trim();
      return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
    });

    // Convert summary bullets into HTML so existing templates can render them
    resumeContent.summary = `
    <ul class="summary-bullets">
      ${summaryBullets.map((bullet) => `<li>${boldToStrong(bullet)}</li>`).join("\n  ")}
    </ul>
    `.trim();

    // Convert experience bullet bold markdown to HTML
    if (Array.isArray(resumeContent.experience)) {
      resumeContent.experience.forEach((exp) => {
        if (Array.isArray(exp.details)) {
          exp.details = exp.details.map(boldToStrong);
        }
      });
    }

    // Skills section: remove ** from category names (e.g. "**Languages**" -> "Languages") so no asterisks display
    if (resumeContent.skills && typeof resumeContent.skills === "object") {
      const skillsClean = {};
      for (const [key, value] of Object.entries(resumeContent.skills)) {
        const cleanKey = typeof key === "string" ? key.replace(/\*/g, "").trim() : key;
        skillsClean[cleanKey || key] = value;
      }
      resumeContent.skills = skillsClean;
    }

    console.log("✅ AI content generated successfully");
    console.log("Skills categories:", Object.keys(resumeContent.skills).length);
    console.log("Experience entries:", resumeContent.experience.length);

    // Debug: Check if experience has details
    resumeContent.experience.forEach((exp, idx) => {
      console.log(`Experience ${idx + 1}: ${exp.title || 'NO TITLE'} - Details count: ${exp.details?.length || 0}`);
      if (!exp.details || exp.details.length === 0) {
        console.error(`⚠️ WARNING: Experience entry ${idx + 1} has NO DETAILS!`);
      }
    });

    // Load Handlebars template (dynamic based on user selection)
    const templateFile = `${templateName}.html`;
    const templatePath = path.join(process.cwd(), "templates", templateFile);

    if (!fs.existsSync(templatePath)) {
      console.error(`Template not found: ${templateFile}`);
      return res.status(404).send(`Template "${templateName}" not found`);
    }

    console.log(`Using template: ${templateFile}`);
    const templateSource = fs.readFileSync(templatePath, "utf-8");

    // Register Handlebars helpers
    Handlebars.registerHelper('formatKey', function (key) {
      // Convert keys like "Programming Languages" or "frontend" to proper format
      return key;
    });

    Handlebars.registerHelper('join', function (array, separator) {
      // Join array elements with separator
      if (Array.isArray(array)) {
        return array.join(separator);
      }
      return '';
    });

    const compiledTemplate = Handlebars.compile(templateSource);

    // Use AI experience when it includes company/dates (e.g. with Cascade Investment); else merge profile + AI by index
    const aiExp = resumeContent.experience || [];
    const hasFullExperience = aiExp.length > 0 && aiExp.every((e) => e.company != null && e.start_date != null && e.end_date != null);
    const experience = hasFullExperience
      ? aiExp.map((e) => ({
        title: e.title || "Engineer",
        company: e.company,
        location: e.location || "",
        start_date: e.start_date,
        end_date: e.end_date,
        details: Array.isArray(e.details) ? e.details : [],
      }))
      : profileData.experience.map((job, idx) => ({
        title: job.title || aiExp[idx]?.title || "Engineer",
        company: job.company,
        location: job.location || "",
        start_date: job.start_date,
        end_date: job.end_date,
        details: aiExp[idx]?.details || [],
      }));

    const templateData = {
      name: resumeContent.name || profileData.name,
      title: resumeContent.title || "Senior Software Engineer",
      email: resumeContent.email || profileData.email,
      phone: resumeContent.phone || profileData.phone,
      location: resumeContent.location || profileData.location,
      linkedin: resumeContent.linkedin || profileData.linkedin || "",
      website: resumeContent.website || profileData.website || "",
      summary: resumeContent.summary,
      skills: resumeContent.skills,
      experience,
      education: resumeContent.education || profileData.education,
    };

    // Render HTML
    const html = compiledTemplate(templateData);
    console.log("HTML rendered from template");

    // Generate PDF with Puppeteer
    const browser = process.env.NODE_ENV === 'production'
      ? await puppeteerCore.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      })
      : await puppeteer.launch({ headless: "new" });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "15mm",
        bottom: "15mm",
        left: "0mm",
        right: "0mm"
      },
    });
    await browser.close();

    console.log("PDF generated successfully!");

    // ===== SAVE 2 PDF FILES DIRECTLY TO LOCAL FOLDER =====

    // Your final local folder
    const outputFolder = process.env.RESUME_OUTPUT_PATH;

    if (!outputFolder) {
      throw new Error("RESUME_OUTPUT_FOLDER is not set in .env.local");
    }

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Keep profile name like Terrance_IvyBrown
    const sanitizeProfileName = (str) =>
      str ? str.replace(/[^A-Za-z0-9_]/g, "") : "resume";

    // Clean company name for filename
    const sanitizeCompanyName = (str) =>
      str ? str.replace(/\s+/g, "").replace(/[^A-Za-z0-9_]/g, "") : "Company";

    const candidateName = sanitizeProfileName(profile); // Terrance_IvyBrown
    const safeCompanyName = sanitizeCompanyName(companyName || "Company");

    // Find next prefix number from existing PDFs or DOCX files
    const existingNumbers = fs
      .readdirSync(outputFolder)
      .map((file) => {
        const match = file.match(/^(\d+)_.*\.(pdf|docx)$/i);
        return match ? Number(match[1]) : null;
      })
      .filter((num) => Number.isFinite(num));

    const nextNumber =
      existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;

    // File 1: numbered PDF
    const numberedPdfName = `${nextNumber}_${candidateName}_${safeCompanyName}.pdf`;
    const numberedPdfPath = path.join(outputFolder, numberedPdfName);

    // File 2: normal PDF
    const normalPdfName = `${candidateName}.pdf`;
    const normalPdfPath = path.join(outputFolder, normalPdfName);

    // Delete old Terrance_IvyBrown.pdf if it exists
    if (fs.existsSync(normalPdfPath)) {
      fs.unlinkSync(normalPdfPath);
    }

    // If caller requested an immediate streamed download, return the PDF as an attachment
    // Use `stream: true` in the request body and `which: 'numbered'|'normal'` to pick file.
    if (req.body && req.body.stream) {
      const which = req.body.which === 'normal' ? 'normal' : 'numbered';
      const streamName = which === 'normal' ? normalPdfName : numberedPdfName;
      const streamBuffer = pdfBuffer;

      // Ensure output folder has the file saved server-side as well
      try {
        fs.writeFileSync(path.join(outputFolder, streamName), streamBuffer);
      } catch (err) {
        console.error('Failed to save streamed PDF to output folder:', err);
      }

      // Send PDF as attachment so browser will prompt for download
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${streamName}"`);
      res.setHeader('Content-Length', streamBuffer.length);
      return res.status(200).send(streamBuffer);
    }

    // Save both PDFs to the configured output folder
    fs.writeFileSync(numberedPdfPath, pdfBuffer);
    fs.writeFileSync(normalPdfPath, pdfBuffer);

    console.log("Created numbered PDF:", numberedPdfPath);
    console.log("Created normal PDF:", normalPdfPath);

    // Also copy the two files into the user's Downloads folder (if accessible)
    let numberedPdfDownloadPath = null;
    let normalPdfDownloadPath = null;
    try {
      const downloadsFolder = path.join(os.homedir(), "Downloads");
      if (!fs.existsSync(downloadsFolder)) {
        fs.mkdirSync(downloadsFolder, { recursive: true });
      }

      numberedPdfDownloadPath = path.join(downloadsFolder, numberedPdfName);
      normalPdfDownloadPath = path.join(downloadsFolder, normalPdfName);

      // Overwrite existing files in Downloads for convenience
      if (fs.existsSync(numberedPdfDownloadPath)) fs.unlinkSync(numberedPdfDownloadPath);
      if (fs.existsSync(normalPdfDownloadPath)) fs.unlinkSync(normalPdfDownloadPath);

      fs.writeFileSync(numberedPdfDownloadPath, pdfBuffer);
      fs.writeFileSync(normalPdfDownloadPath, pdfBuffer);

      console.log("Copied PDFs to Downloads:", numberedPdfDownloadPath, normalPdfDownloadPath);
    } catch (err) {
      console.error("Failed to copy PDFs to Downloads folder:", err);
      // leave download paths as null; do not fail the entire request
    }

    // If caller requested base64 inline return (useful for remote hosts like Render), include base64 payloads
    let numberedBase64 = null;
    let normalBase64 = null;
    if (returnBase64) {
      try {
        numberedBase64 = pdfBuffer.toString('base64');
        normalBase64 = pdfBuffer.toString('base64');
      } catch (err) {
        console.error('Failed to encode PDFs to base64:', err);
      }
    }

    // Return success response to frontend
    return res.status(200).json({
      success: true,
      message: "PDF files saved successfully",
      numberedFile: numberedPdfPath,
      normalFile: normalPdfPath,
      numberedDownloadFile: numberedPdfDownloadPath,
      normalDownloadFile: normalPdfDownloadPath,
      numberedBase64,
      normalBase64,
      nextNumber,
    });


  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).send("PDF generation failed: " + err.message);
  }
}

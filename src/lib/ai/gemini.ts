/**
 * Google Gemini AI Client for Contribo & Proposal Studio
 * API key is never logged — passed only via x-goog-api-key header.
 */

import { safeLogError } from '@/lib/security';

export type GeminiImproveResult = {
  text: string;
  rationale: string;
};

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
  'gemini-1.5-flash',
] as const;

export async function generateGeminiContent(
  prompt: string,
  systemInstruction?: string,
  options?: { responseMimeType?: string; maxTokens?: number; temperature?: number }
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.warn('GEMINI_API_KEY missing in environment.');
    return null;
  }

  // Bound prompt size to reduce cost / abuse if callers pass huge drafts
  const safePrompt = prompt.slice(0, 32_000);
  const safeSystem = systemInstruction?.slice(0, 8_000);

  const payload: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: safeSystem
              ? `${safeSystem}\n\nUser Request:\n${safePrompt}`
              : safePrompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: options?.temperature ?? 0.2,
      maxOutputTokens: options?.maxTokens ?? 2048,
      ...(options?.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
    },
  };

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(9000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText && typeof candidateText === 'string') {
          return candidateText.trim();
        }
      } else if (res.status === 401 || res.status === 403) {
        console.warn(`Gemini auth failed for model ${model} (HTTP ${res.status})`);
        return null;
      }
    } catch (err) {
      safeLogError(`Gemini API call failed (model=${model}):`, err);
    }
  }

  return null;
}

export async function generateGeminiStructuredJson<T>(
  prompt: string,
  systemInstruction?: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<T | null> {
  const text = await generateGeminiContent(prompt, systemInstruction, {
    responseMimeType: 'application/json',
    temperature: options?.temperature ?? 0.2,
    maxTokens: options?.maxTokens ?? 2500,
  });

  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    // If wrapped in markdown code fence, strip it
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function improveProposalSectionWithGemini(params: {
  sectionTitle: string;
  projectTitle: string;
  orgName: string;
  currentContent: string;
}): Promise<GeminiImproveResult | null> {
  const systemInstruction = `You are a senior open-source maintainer and Google Summer of Code (GSoC/LFX) proposal reviewer.
Your goal is to enhance the student's proposal section to meet open-source maintainer standards.
Requirements:
1. Increase technical specificity, mention concrete interfaces/modules, test coverage goals (e.g. PyTest/Jest 90%+), and risk buffers.
2. Return a JSON object with two fields:
   - "enhancedText": the enhanced section content in clean Markdown.
   - "rationale": 1 short sentence summarizing what was improved.
Do not include code block ticks in the output, return raw JSON.`;

  const prompt = `Project: ${params.projectTitle.slice(0, 300)}
Organization: ${params.orgName.slice(0, 200)}
Section: ${params.sectionTitle.slice(0, 120)}

Current Section Content:
"""
${(params.currentContent || '(Section currently empty)').slice(0, 20_000)}
"""`;

  try {
    const rawResponse = await generateGeminiContent(prompt, systemInstruction);
    if (rawResponse) {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          enhancedText?: string;
          rationale?: string;
        };
        if (parsed.enhancedText && parsed.rationale) {
          return {
            text: String(parsed.enhancedText).slice(0, 50_000),
            rationale: String(parsed.rationale).slice(0, 500),
          };
        }
      }
      return {
        text: rawResponse.slice(0, 50_000),
        rationale: `Enhanced ${params.sectionTitle} using Google Gemini AI.`,
      };
    }
  } catch (err) {
    safeLogError('Gemini section improvement failed:', err);
  }

  return null;
}

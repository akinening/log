import { defineCollection, z } from "astro:content";

const works = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    company: z.string(),
    period: z.string(),
    team: z.string(),
    role: z.string(),
    year: z.string(),
    thumbnail: z.string(),
    tags: z.array(z.string()).default([]),
    // 成果として語れる数字だけを載せる（担当範囲などは role 欄の仕事）。
    // 弱い数字で3つに揃えるくらいなら少ない方が強く見える
    metrics: z
      .array(
        z.object({
          value: z.string(),
          label: z.string(),
          note: z.string().optional()
        })
      )
      .min(1)
      .max(3),
    tldr: z
      .object({
        problem: z.string(),
        approach: z.string(),
        outcome: z.string()
      })
      .optional(),
    order: z.number(),
    accent: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
      .optional()
  })
});

export const collections = { works };

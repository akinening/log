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
    metrics: z
      .array(
        z.object({
          value: z.string(),
          label: z.string(),
          note: z.string().optional()
        })
      )
      .length(3),
    order: z.number(),
    accent: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
      .optional()
  })
});

export const collections = { works };

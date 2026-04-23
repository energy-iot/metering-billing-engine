// utils.ts — standard shadcn helper.
// If `npx shadcn init` already scaffolded this, this file is redundant;
// the contents are identical to the shadcn default.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

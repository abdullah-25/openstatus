import type { SignedInAuthObject } from "@clerk/nextjs/api";
import { Client } from "@upstash/qstash/cloudflare";
import type { z } from "zod";

import { createTRPCContext } from "@openstatus/api";
import { edgeRouter } from "@openstatus/api/src/edge";
import { selectMonitorSchema } from "@openstatus/db/src/schema";
import { availableRegions } from "@openstatus/tinybird";

import { env } from "@/env";
import type { payloadSchema } from "../schema";

const periodicityAvailable = selectMonitorSchema.pick({ periodicity: true });

// FIXME: do coerce in zod instead

const DEFAULT_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

// We can't secure cron endpoint by vercel thus we should make sure they are called by the generated url
export const isAuthorizedDomain = (url: string) => {
  return url.includes(DEFAULT_URL);
};

export const cron = async ({
  periodicity,
  req,
}: z.infer<typeof periodicityAvailable> & { req: Request }) => {
  const c = new Client({
    token: env.QSTASH_TOKEN,
  });
  console.log(`Start cron for ${periodicity}`);
  const timestamp = Date.now();

  const ctx = createTRPCContext({ req, serverSideCall: true });
  ctx.auth = { userId: "cron" } as SignedInAuthObject;
  const caller = edgeRouter.createCaller(ctx);

  const monitors = await caller.monitor.getMonitorsForPeriodicity({
    periodicity: periodicity,
  });

  const allResult = [];

  for (const row of monitors) {
    const allPages = await caller.monitor.getAllPagesForMonitor({
      monitorId: row.id,
    });

    if (row.regions.length === 0) {
      const payload: z.infer<typeof payloadSchema> = {
        workspaceId: String(row.workspaceId),
        method: row.method || "GET",
        monitorId: String(row.id),
        url: row.url,
        headers: row.headers,
        body: row.body,
        cronTimestamp: timestamp,
        pageIds: allPages.map((p) => String(p.pageId)),
      };

      // TODO: fetch + try - catch + retry once
      const result = c.publishJSON({
        url: `${DEFAULT_URL}/api/checker/regions/auto`,
        body: payload,
        delay: Math.random() * 90,
      });
      allResult.push(result);
    } else {
      const allMonitorsRegions = row.regions;
      for (const region of allMonitorsRegions) {
        const payload: z.infer<typeof payloadSchema> = {
          workspaceId: String(row.workspaceId),
          monitorId: String(row.id),
          url: row.url,
          method: row.method || "GET",
          cronTimestamp: timestamp,
          body: row.body,
          headers: row.headers,
          pageIds: allPages.map((p) => String(p.pageId)),
        };

        const result = c.publishJSON({
          url: `${DEFAULT_URL}/api/checker/regions/${region}`,
          body: payload,
        });
        allResult.push(result);
      }
    }
  }
  // our first legacy monitor
  if (periodicity === "10m") {
    // Right now we are just checking the ping endpoint
    for (const region of availableRegions) {
      const payload: z.infer<typeof payloadSchema> = {
        workspaceId: "openstatus",
        monitorId: "openstatusPing",
        url: `${DEFAULT_URL}/api/ping`,
        cronTimestamp: timestamp,
        method: "GET",
        pageIds: ["openstatus"],
      };

      // TODO: fetch + try - catch + retry once
      const result = c.publishJSON({
        url: `${DEFAULT_URL}/api/checker/regions/${region}`,
        body: payload,
        delay: Math.random() * 90,
      });
      allResult.push(result);
    }
  }
  await Promise.all(allResult);
  console.log(`End cron for ${periodicity} with ${allResult.length} jobs`);
};

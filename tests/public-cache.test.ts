// Failure modes: a reader can reuse withdrawn text for more than six minutes; stale-while-revalidate
// extends that window; report images use the static brand lifetime; conditional reads restore it.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { publishArticle } from '@aihot/backend/publication/publish';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { buildApp } from '../apps/api/src/app.ts';

const app = await buildApp();
const T = tag();
let id: string;
before(async () => {
  // Found, published and released a minute ago: a rolling window that ends at the reader's clock holds it.
  const minuteAgo = new Date(Date.now()-60000);
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES(${T},'Cache example','rss','T1','editorial',true,true)`;
  id = (await upsertMaterial({ sourceId:T, url:`https://example.com/${T}`,title:'公开缓存示例',
    bodyText:'允许公开的正文。'.repeat(50),bodyStatus:'ok',via:'fetch',publishedAt:minuteAgo,discoveredAt:minuteAgo })).articleId;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'rule','pass','new-car','公开缓存示例','公开缓存摘要',90,true)`;
  await publishArticle(id,{releasedAt:minuteAgo});
  for (const [kind,key] of [['daily','2099-10-04'],['weekly','2099-W40'],['monthly','2099-10']]) {
    const entry = {itemId:id,title:'公开缓存示例',summary:'公开缓存摘要'};
    const content = kind==='daily' ? {sections:[{label:'模型',items:[entry]}],flashes:[]}
      : {headline:'公开缓存示例',themes:[{heading:'模型',storyRefs:[entry]}]};
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
      VALUES(${kind!},${key!},now()-interval '1 day',now(),${sql.json(content)},now())`;
  }
});
after(async()=>{await app.close();await stopBoss();await closeDb();});

test('mutable content never authorizes a reader to reuse stale data beyond the withdrawal window',async(t)=>{
  const paths = ['/api/v1/agent','/openapi-v1.json','/api/v1/items','/api/v1/dailies','/api/v1/dailies/2099-10-04',
    '/api/v1/weeklies/2099-W40','/api/v1/monthlies/2099-10','/api/v1/selected/snapshot',
    '/api/v1/agent/daily/2099-10-04','/api/v1/agent/weekly/2099-W40',
    '/feed.xml','/feed/full.xml','/feed/all.xml','/feed/daily.xml','/feed/weekly.xml','/feed/monthly.xml',
    `/items/${id}/markdown`, `/og/items/${id}.png`, `/og/posters/${id}.png`,
    '/og/reports/daily/2099-10-04.png','/og/reports/weekly/2099-W40.png','/og/reports/monthly/2099-10.png'];
  const failures:string[]=[];
  for (const url of paths) {
    const response=await app.inject({method:'GET',url});
    assert.equal(response.statusCode,200,url);
    const responses=[response];
    if(response.headers.etag){
      // A VM's wall clock steps back when it syncs with its host (on the CI VMs by as much as 0.4 s).
      t.mock.timers.enable({apis:['Date'],now:Date.now()-1000});
      const conditional=await app.inject({method:'GET',url,headers:{'if-none-match':String(response.headers.etag)}});
      t.mock.timers.reset();
      assert.equal(conditional.statusCode,304,url);
      responses.push(conditional);
    }
    for(const r of responses){
      const cc=String(r.headers['cache-control']);
      const ttl=Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)?.[1]??Infinity);
      const stale=Number(cc.match(/stale-while-revalidate=(\d+)/)?.[1]??0);
      if(ttl+stale>360) failures.push(`${url} ${r.statusCode}: ${cc}`);
    }
  }
  assert.deepEqual(failures,[], 'a cache purge cannot evict a reader\'s private HTTP cache');
});

test('report, story and hot responses share a one-minute deadline with the pages that read them', async (t) => {
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${publicId}, 'Cache example story', now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`fact-${publicId}`}, ${story!.id}, 'Cache example fact') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;

  const index = '/api/site/reports/daily';
  const latest = `${index}/latest-page`;
  const detail = `${index}/2099-10-04`;
  const storyUrl = `/api/site/stories/${publicId}`;
  const paths = [index, latest, detail, `${index}/navigation/2099-10-04`, `${index}/months/2099-10`, storyUrl, '/api/site/hot'];
  const withdrawnText = new Map([[index, '公开缓存示例'], [latest, '公开缓存摘要'], [detail, '公开缓存摘要'], [storyUrl, '公开缓存示例']]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const url of paths) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    const expiry = String(response.headers['x-accel-expires']);
    assert.match(expiry, /^@\d+$/, url);
    const seconds = Number(expiry.slice(1)) - Math.floor(Date.now() / 1000);
    assert.ok(seconds > 0 && seconds <= 61, `${url}: ${seconds}s`);
    const text = withdrawnText.get(url);
    if (text) assert.ok(response.body.includes(text), url);
  }

  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  t.mock.timers.tick(61_000);
  for (const [url, text] of withdrawnText) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, url === storyUrl ? 404 : 200, url);
    assert.ok(!response.body.includes(text), `${url} still shows withdrawn content`);
  }
  for (const url of [`${index}/1900-01-01`, storyUrl]) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.headers['cache-control'], 'no-store', url);
    assert.equal(response.headers['x-accel-expires'], undefined, url);
  }
});

function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function fmtBytesExact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  if (n < 1024) return `${n} B`;
  return `${fmtBytes(n)} (${n.toLocaleString('en-US')} B)`;
}
function fmtPct(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'unknown';
  return `${(ratio * 100).toFixed(1)}%`;
}
function fmtExport(names) {
  if (names === null || names === undefined) return '<null>';
  if (Array.isArray(names) && !names.length) return '<namespace/*>';
  return JSON.stringify(names);
}
function fmtUsed(usage) {
  if (!usage) return '-';
  if (usage.usedDetail === 'none' || usage.usedState === 'none') return 'none';
  if (usage.usedDetail === 'named' || usage.usedState === 'named') return `named(${usage.usedExportCount ?? '?'})`;
  if (usage.usedDetail === 'all') return 'all/unknown';
  return 'unknown';
}
function fmtLoc(loc) {
  if (!loc || !loc.start) return '?';
  const s = `${loc.start.line}:${loc.start.column}`;
  if (!loc.end) return s;
  if (loc.end.line === loc.start.line) return `${s}-${loc.end.column}`;
  return `${s}-${loc.end.line}:${loc.end.column}`;
}
function fmtOwners(chain, detailed = false) {
  if (!chain || !chain.length) return '<top-level>';
  return chain.map(o => detailed ? `${o.name} (${o.kind} @${o.start.line}:${o.start.column})` : o.name).join(' > ');
}
function fmtSpaceTag(m) {
  if (!m) return 'unmapped';
  if (m.coordinateSpace === 'resource') return 'resource';
  if (m.coordinateSpace === 'map-source') return m.sourceIdentity?.matchesCapturedResource ? 'mapped->resource' : 'map-source';
  if (m.coordinateSpace === 'post-loader') return 'post-loader';
  return m.locationPrecision === 'unavailable' ? 'unmapped' : (m.locationPrecision || 'unmapped');
}
function shortHash(h) { return h ? `sha256:${h.slice(0, 8)}` : 'none'; }
function escCell(v) {
  if (v === null || v === undefined) return '-';
  return String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
function fmtTable(headers, rows, alignRight = new Set()) {
  if (!rows.length) return '(none)';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map((_, i) => alignRight.has(i) ? '---:' : '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.map(escCell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function fmtSnippet(snippet, location, indent = '   ') {
  if (!snippet || !snippet.lines?.length) return '';
  const width = Math.max(3, String(snippet.endLine).length);
  const out = [];
  for (const line of snippet.lines) {
    const isFocus = location?.start?.line === line.line;
    const prefix = isFocus ? '>' : ' ';
    const num = String(line.line).padStart(width, ' ');
    const suffix = line.truncated ? ' ...' : '';
    const lead = line.columnOffset ? '...' : '';
    out.push(`${indent}${prefix} ${num} | ${lead}${line.text}${suffix}`);
    if (isFocus && location?.start) {
      const leadLen = lead.length;
      const startCol = Math.max(0, location.start.column - (line.columnOffset || 0));
      let len = 1;
      if (location.end && location.end.line === line.line) {
        len = Math.max(1, Math.min(location.end.column - location.start.column, Math.max(1, line.text.length - startCol)));
      }
      const pad = ' '.repeat(Math.min(startCol + leadLen, Math.max(0, line.text.length + leadLen)));
      out.push(`${indent}  ${' '.repeat(width)} | ${pad}${'^'.repeat(len)}`);
    }
  }
  return out.join('\n');
}

function fmtHelp(data) {
  const lines = [];
  if (data.singleCommand) {
    const name = data.singleCommand;
    const spec = data.commands[name];
    lines.push(`# ${name} — ${spec.summary}`);
    lines.push(`usage: ${spec.usage}`);
    if (spec.options.length) lines.push(`options: ${spec.options.map(o => `--${o}`).join(', ')}`);
    if (spec.required?.length) lines.push(`required: ${spec.required.join(', ')}`);
    if (spec.sortFields?.length) lines.push(`sort fields: ${spec.sortFields.join(', ')}`);
    if (spec.details?.length) {
      lines.push('');
      for (const d of spec.details) lines.push(`- ${d}`);
    }
    if (spec.examples?.length) {
      lines.push('', '## Examples');
      for (const ex of spec.examples) lines.push(`  ${ex}`);
    }
    return lines.join('\n');
  }
  lines.push(`# ${data.name} (default output: --format text; pass --format json for JSON)`);
  lines.push(`usage: ${data.usage}`, '');
  lines.push('## Commands');
  for (const [name, spec] of Object.entries(data.commands)) {
    lines.push(`- ${name.padEnd(8)} ${spec.summary}`);
  }
  lines.push('', '## Common Options');
  lines.push('- --db <index.sqlite>       Query index database (required for all query commands)');
  lines.push('- --format text|json        Output format (default: text)');
  lines.push('- --help / -h               Show help (use `<command> --help` for command details)');
  lines.push('', '## Typical Workflow');
  lines.push('  1. query.cjs index --build build.sqlite --coverage recording.json --out index.sqlite');
  lines.push('  2. query.cjs status --db index.sqlite');
  lines.push('  3. query.cjs chunks --db index.sqlite');
  lines.push('  4. query.cjs modules --db index.sqlite --scope loaded --max-ratio 0.2 --sort coverage.generated.unexecutedBytes:desc');
  lines.push('  5. query.cjs module --db index.sqlite --module <moduleId>');
  lines.push('  6. query.cjs source --db index.sqlite --module <moduleId> --unexecuted');
  lines.push('  7. query.cjs refs --db index.sqlite --module <moduleId>');
  lines.push('  8. query.cjs chain --db index.sqlite --module <moduleId> --export <name>');
  return lines.join('\n');
}

function fmtIndex(data) {
  const lines = ['# Index Created'];
  lines.push(`database: ${data.database}`);
  lines.push(`dataset: ${data.datasetId}  build: ${data.buildId}${data.compiler ? `  compiler: ${data.compiler}` : ''}${data.scenario ? `  scenario: ${data.scenario}` : ''}${data.precision ? `  precision: ${data.precision}` : ''}`);
  const c = data.counts;
  lines.push(`counts: modules=${c.modules}  edges=${c.edges}  sources=${c.sources}  chunks=${c.chunks}  chunkGroups=${c.chunkGroups}  coverageLines=${c.coverageLines}  gaps=${c.gaps}`);
  if (data.generated) {
    const g = data.generated;
    const ratio = g.loadedBytes > 0 && g.executedBytes !== null ? g.executedBytes / g.loadedBytes : null;
    lines.push(`generated: emitted=${fmtBytes(g.emittedBytes)}  loaded=${fmtBytes(g.loadedBytes)}  exec=${fmtBytes(g.executedBytes)} (${fmtPct(ratio)})  unexec=${fmtBytes(g.unusedBytes)}  mapped=${fmtBytes(g.mappedBytes)}  unmapped=${fmtBytes(g.unmappedBytes)}`);
  }
  lines.push(`next: query.cjs status --db ${data.database}`);
  return lines.join('\n');
}

function fmtGapDetail(detail) {
  if (!detail) return '-';
  if (typeof detail === 'string') return detail;
  if (detail.url && detail.reason) return `${detail.url} — ${detail.reason}`;
  if (detail.asset && detail.message) return `${detail.asset} — ${detail.message}`;
  if (detail.path && detail.message) return `${detail.path} — ${detail.message}`;
  if (detail.message) return detail.sourceId ? `${detail.message} (${detail.sourceId})` : detail.message;
  return JSON.stringify(detail);
}

function fmtStatus(data) {
  if (data.mode === 'gaps') {
    const lines = [`# Gaps (showing ${data.page.returned}/${data.page.total})`];
    lines.push('', fmtTable(
      ['gapId', 'kind', 'module', 'detail'],
      data.items.map(g => [g.gapId, g.kind, g.moduleId ? `${g.modulePath || '?'} (${g.moduleId})` : '-', fmtGapDetail(g.detail)]),
    ));
    if (data.page.nextCursor) lines.push('', `next page: --cursor ${data.page.nextCursor}`);
    return lines.join('\n');
  }
  const lines = ['# Status'];
  const header = [`dataset: ${data.datasetId}`, `build: ${data.buildId}`];
  if (data.compiler) header.push(`compiler: ${data.compiler}`);
  if (data.scenario) header.push(`scenario: ${data.scenario}`);
  lines.push(header.join('  '));
  lines.push(`context: ${data.context}`);
  const caps = data.capabilities;
  lines.push(`capabilities: coverage=${caps.coverage ? `yes (${data.coveragePrecision || 'unknown'}, scopes: ${caps.scopes.join(',')})` : 'no'} | nativeUsage=${caps.nativeUsage ? 'yes' : 'no'}`);
  const c = data.counts;
  lines.push(`counts: modules=${c.modules}  edges=${c.edges}  sources=${c.sources}  chunks=${c.chunks}  chunkGroups=${c.chunkGroups}  coverageLines=${c.coverageLines}  gaps=${c.gaps}`);
  if (data.generated) {
    const g = data.generated;
    const ratio = g.loadedBytes > 0 && g.executedBytes !== null ? g.executedBytes / g.loadedBytes : null;
    lines.push('', '## Generated JS (UTF-8)');
    lines.push(`emitted: ${fmtBytesExact(g.emittedBytes)} | mapped: ${fmtBytes(g.mappedBytes)} | unmapped: ${fmtBytes(g.unmappedBytes)}`);
    lines.push(`loaded:  ${fmtBytesExact(g.loadedBytes)} | executed: ${fmtBytes(g.executedBytes)} (${fmtPct(ratio)}) | unexecuted: ${fmtBytes(g.unusedBytes)}`);
  }
  if (data.recording) {
    const r = data.recording;
    lines.push('', '## Recording');
    lines.push(`matchedAssets: ${r.matchedAssets}  ignoredScripts: ${r.ignoredScripts}  mappingWarnings: ${r.mappingWarnings}  scopeGaps: ${r.scopeGaps}`);
  }
  if (data.gapsPreview?.length) {
    lines.push('', `## Gaps (${data.gapsPreview.length}/${c.gaps})`);
    lines.push(fmtTable(
      ['kind', 'module', 'detail'],
      data.gapsPreview.map(g => [g.kind, g.moduleId ? `${g.modulePath || '?'} (${g.moduleId})` : '-', fmtGapDetail(g.detail)]),
    ));
  } else if (c.gaps > 0) {
    lines.push('', `gaps: ${c.gaps} -> inspect with \`status --gaps\``);
  }
  lines.push('', '## Notes');
  lines.push('- coverage is recording evidence only (not removable-code or gzip proof); unknown != 0.');
  lines.push('- usage graph is compile-time relations, not a runtime call graph.');
  return lines.join('\n');
}

function fmtChunks(data) {
  if (data.mode === 'chunk') {
    const ch = data.chunk;
    const lines = [`# Chunk ${ch.chunkId} (initial=${ch.initial}, loaded=${ch.loaded === null ? 'unknown' : ch.loaded}, showing ${data.page.returned}/${data.page.total} modules)`];
    if (ch.files.length) lines.push(`files: ${ch.files.join(', ')}`);
    if (ch.generated) {
      lines.push(`generated: emitted=${fmtBytes(ch.generated.emittedBytes)} | loaded=${fmtBytes(ch.generated.loadedBytes)} | exec=${fmtBytes(ch.generated.executedBytes)} (${fmtPct(ch.generated.executionRatio)}) | unexec=${fmtBytes(ch.generated.unexecutedBytes)}`);
    }
    if (data.coverageAvailable === false) {
      lines.push('', fmtTable(
        ['moduleId', 'path', 'used'],
        data.items.map(m => [m.moduleId, m.path, fmtUsed(m.usage)]),
      ));
    } else {
      lines.push('', fmtTable(
        ['moduleId', 'path', 'gen.unexec', 'gen.loaded', 'exec%', 'used'],
        data.items.map(m => [
          m.moduleId, m.path,
          fmtBytes(m.coverage?.generated?.unexecutedBytes),
          fmtBytes(m.coverage?.generated?.loadedBytes),
          fmtPct(m.coverage?.generated?.executionRatio),
          fmtUsed(m.usage),
        ]),
        new Set([2, 3, 4]),
      ));
    }
    if (data.page.nextCursor) lines.push('', `next page: --cursor ${data.page.nextCursor}`);
    return lines.join('\n');
  }

  if (data.mode === 'group') {
    const g = data.group;
    const secNote = data.section ? ` [section=${data.section}, offset=${data.sectionPage.offset}, showing ${data.sectionPage.returned}/${data.sectionPage.total}]` : '';
    const lines = [`# Chunk Group ${g.groupId}${g.name ? ` (${g.name})` : ''}${g.multiOrigin ? ' [MULTI-ORIGIN]' : ''}${secNote}`];
    lines.push(`modules: ${g.totalModules}  chunks: ${g.chunksTotal ?? data.chunks.length}  origins: ${g.originsTotal ?? data.origins.length}${g.parents.length ? `  parents: ${g.parents.join(', ')}` : ''}`);

    if (!data.section || data.section === 'chunks') {
      const total = g.chunksTotal ?? data.chunks.length;
      lines.push('', `## Chunks (${data.chunks.length}/${total})`);
      lines.push(fmtTable(
        ['chunkId', 'initial', 'loaded', 'modules', 'emitted', 'unexec', 'files'],
        data.chunks.map(c => [
          c.chunkId, c.initial, c.loaded === null ? 'unknown' : c.loaded, c.moduleCount,
          fmtBytes(c.generated?.emittedBytes), fmtBytes(c.generated?.unexecutedBytes), c.files.join(', ') || '-',
        ]),
        new Set([3, 4, 5]),
      ));
      if (!data.section && data.chunks.length < total) lines.push(`more chunks: chunks --group ${g.groupId} --section chunks --offset ${data.chunks.length}`);
    }

    if (!data.section || data.section === 'origins') {
      const total = g.originsTotal ?? data.origins.length;
      lines.push('', `## Origins (${data.origins.length}/${total})`);
      lines.push(fmtTable(
        ['origin', 'request', 'entryModules', 'status', 'reachableMods'],
        data.origins.map(o => [
          o.moduleId ? `${o.path || '?'} (${o.moduleId})` : '<entry>',
          o.request || '-',
          o.entryPaths.join(', ') || '-',
          o.executionStatus,
          o.reachableModuleCount,
        ]),
        new Set([4]),
      ));
      if (!data.section && data.origins.length < total) lines.push(`more origins: chunks --group ${g.groupId} --section origins --offset ${data.origins.length}`);
    }

    if (!data.section || data.section === 'candidates') {
      const a = data.analysis;
      lines.push('', '## Origin Reachability Analysis');
      if (!a.coverageAvailable) {
        lines.push('Coverage unavailable; cannot distinguish executed vs unexecuted origins.');
      } else if (a.unnecessaryCandidateCount > 0) {
        lines.push(`executed origins: ${a.executedOriginCount}, unexecuted origins: ${a.unexecutedOriginCount} -> ${a.unnecessaryCandidateCount} candidate unnecessary module(s) (${fmtBytes(a.unnecessaryCandidateBytes)} unexecuted) reachable only from unexecuted origin(s) (showing ${a.candidates.length}/${a.unnecessaryCandidateCount}):`);
        lines.push('', fmtTable(
          ['moduleId', 'path', 'emitted', 'unexec'],
          a.candidates.map(m => [m.moduleId, m.path, fmtBytes(m.emittedBytes), fmtBytes(m.unexecutedBytes)]),
          new Set([2, 3]),
        ));
        if (!data.section && a.candidates.length < a.unnecessaryCandidateCount) lines.push(`more candidates: chunks --group ${g.groupId} --section candidates --offset ${a.candidates.length}`);
      } else {
        lines.push(`executed origins: ${a.executedOriginCount}, unexecuted origins: ${a.unexecutedOriginCount} -> no modules uniquely attributable to unexecuted origins.`);
      }
    }

    if (data.section && data.sectionPage?.nextOffset !== null) {
      lines.push('', `next page: chunks --group ${g.groupId} --section ${data.section} --offset ${data.sectionPage.nextOffset}`);
    }
    return lines.join('\n');
  }

  // Overview
  const filterBits = [];
  if (data.filters?.multiOrigin) filterBits.push('multi-origin');
  if (data.filters?.loaded) filterBits.push('loaded');
  if (data.filters?.search) filterBits.push(`search=${data.filters.search}`);
  const filterStr = filterBits.length ? `, filter=${filterBits.join(',')}` : '';
  const lines = [`# Chunks & Chunk Groups (groups=${data.page.total}, chunks=${data.chunks.total}${filterStr})`];
  if (data.items.length) {
    lines.push('', `## Chunk Groups (showing ${data.page.returned}/${data.page.total})`);
    if (data.coverageAvailable === false) {
      lines.push(fmtTable(
        ['groupId', 'name', 'chunks', 'mods', 'origins'],
        data.items.map(g => [
          g.groupId,
          `${g.name || '-'}${g.multiOrigin ? ' [MULTI]' : ''}`,
          g.chunkIds.join(','),
          g.moduleCount,
          `${g.originCount}: ${g.origins.map(o => o.request || o.path || '<entry>').join(', ')}`,
        ]),
        new Set([3]),
      ));
    } else {
      lines.push(fmtTable(
        ['groupId', 'name', 'chunks', 'loaded', 'mods', 'emitted', 'unexec', 'origins'],
        data.items.map(g => [
          g.groupId,
          `${g.name || '-'}${g.multiOrigin ? ' [MULTI]' : ''}`,
          g.chunkIds.join(','),
          g.loaded === null ? 'unknown' : g.loaded,
          g.moduleCount,
          fmtBytes(g.emittedBytes),
          fmtBytes(g.unexecutedBytes),
          `${g.originCount}: ${g.origins.map(o => o.request || o.path || '<entry>').join(', ')}`,
        ]),
        new Set([4, 5, 6]),
      ));
    }
    if (data.page.nextCursor) lines.push(`next page: --cursor ${data.page.nextCursor}`);
  } else if (data.chunks.items.length) {
    lines.push('', `## Chunks (showing ${data.chunks.items.length}/${data.chunks.total})`);
    lines.push(fmtTable(
      ['chunkId', 'initial', 'loaded', 'mods', 'emitted', 'unexec', 'files'],
      data.chunks.items.map(c => [
        c.chunkId, c.initial, c.loaded === null ? 'unknown' : c.loaded, c.moduleCount,
        fmtBytes(c.generated?.emittedBytes), fmtBytes(c.generated?.unexecutedBytes), c.files.join(', ') || '-',
      ]),
      new Set([3, 4, 5]),
    ));
  } else {
    lines.push('', '(no matching chunk groups)');
  }
  lines.push('', 'hint: filter with `chunks --multi-origin [--loaded] [--search <name>]`, inspect a group with `chunks --group <groupId>`, or a chunk with `chunks --chunk <chunkId>`');
  return lines.join('\n');
}

function fmtModules(data) {
  const rankInfo = data.ranking ? `, known=${data.ranking.known} unknown=${data.ranking.unknown}` : '';
  const sortStr = data.query?.sort ? `, sort=${data.query.sort}` : '';
  const lines = [`# Modules (scope=${data.scope}${sortStr}, showing ${data.page.returned}/${data.page.total}${rankInfo})`];
  if (data.fields?.length) {
    const cols = ['moduleId', ...data.fields.filter(f => f !== 'moduleId')];
    const read = (obj, field) => {
      let val = obj;
      for (const k of field.split('.')) val = val == null ? null : val[k];
      if (val === null || val === undefined) return 'unknown';
      if (field.endsWith('Bytes')) return fmtBytes(val);
      if (field.endsWith('Ratio')) return fmtPct(val);
      if (typeof val === 'object') return JSON.stringify(val);
      return val;
    };
    lines.push('', fmtTable(cols, data.items.map(m => cols.map(c => read(m, c)))));
  } else if (data.coverageAvailable === false) {
    lines.push('', fmtTable(
      ['moduleId', 'path', 'pkg', 'used', 'inRefs', 'consumers'],
      data.items.map(m => [
        m.moduleId,
        m.path ?? m.identifier ?? '-',
        m.package ?? '-',
        fmtUsed(m.usage),
        m.usage?.incomingReferences ?? 'unknown',
        m.usage?.distinctConsumers ?? 'unknown',
      ]),
      new Set([4, 5]),
    ));
  } else {
    lines.push('', fmtTable(
      ['moduleId', 'path', 'pkg', 'gen.unexec', 'gen.loaded', 'exec%', 'used', 'inRefs', 'consumers'],
      data.items.map(m => [
        m.moduleId,
        m.path ?? m.identifier ?? '-',
        m.package ?? '-',
        fmtBytes(m.coverage?.generated?.unexecutedBytes),
        fmtBytes(m.coverage?.generated?.loadedBytes),
        fmtPct(m.coverage?.generated?.executionRatio),
        fmtUsed(m.usage),
        m.usage?.incomingReferences ?? 'unknown',
        m.usage?.distinctConsumers ?? 'unknown',
      ]),
      new Set([3, 4, 5, 7, 8]),
    ));
  }
  const hints = [];
  if (data.page.nextCursor) hints.push(`next page: --cursor ${data.page.nextCursor}`);
  hints.push('hint: inspect with `module --module <moduleId>`, read code with `source --module <moduleId>`, or inspect usages with `refs --module <moduleId>`');
  if (data.gapsCount > 0) hints.push(`gaps=${data.gapsCount} (see \`status --gaps\`)`);
  lines.push('', ...hints);
  return lines.join('\n');
}

function fmtModule(data) {
  const lines = [`# Module ${data.moduleId}`];
  const metaBits = [`path: ${data.path}`];
  if (data.type) metaBits.push(`type: ${data.type}`);
  if (data.layer) metaBits.push(`layer: ${data.layer}`);
  if (data.package) metaBits.push(`pkg: ${data.package}`);
  metaBits.push(`loaded: ${data.loaded === null ? 'unknown' : data.loaded}`);
  metaBits.push(`initial: ${data.initial === null ? 'unknown' : data.initial}`);
  lines.push(metaBits.join('  '));
  if (data.identifier && data.identifier !== data.path) {
    const ident = data.identifier.length > 180
      ? `${data.identifier.slice(0, 120)}... (${data.identifier.length} chars; use --format json for full)`
      : data.identifier;
    lines.push(`identifier: ${ident}`);
  }

  if (data.chunks?.length) {
    lines.push(`chunks: ${data.chunks.map(c => `${c.chunkId}(${c.initial ? 'init,' : ''}loaded=${c.loaded === null ? '?' : c.loaded}${c.files.length ? ',' + c.files.join('+') : ''})`).join(', ')}`);
  }

  lines.push('', `## Coverage (scope=${data.scope})`);
  if (!data.coverage.available) {
    lines.push('unavailable (compile-time index only)');
  } else {
    const g = data.coverage.generated;
    const s = data.coverage.retainedSource;
    lines.push(g
      ? `generated:      emitted=${fmtBytesExact(g.emittedBytes)} | loaded=${fmtBytes(g.loadedBytes)} | exec=${fmtBytes(g.executedBytes)} (${fmtPct(g.executionRatio)}) | unexec=${fmtBytes(g.unexecutedBytes)}`
      : `generated:      unknown (${data.coverage.generatedAttribution})`);
    if (s) {
      lines.push(`retainedSource: emitted=${fmtBytes(s.emittedBytes)} | loaded=${fmtBytes(s.loadedBytes)} | exec=${fmtBytes(s.executedBytes)} (${fmtPct(s.executionRatio)}) | unexec=${fmtBytes(s.unexecutedBytes)}`);
    }
  }

  lines.push('', '## Usage');
  lines.push(`providedExports: ${data.providedExportCount ?? 'unknown'} | usedExports: ${fmtUsed(data.usage)}`);
  lines.push(`native incoming: ${data.usage.incomingReferences ?? 'unknown'} refs from ${data.usage.distinctConsumers ?? 'unknown'} consumers | module-graph: in=${data.moduleReferences.incoming} out=${data.moduleReferences.outgoing}`);

  if (data.sources.items.length) {
    lines.push('', `## Sources (${data.sources.items.length}/${data.sources.total})`);
    for (const s of data.sources.items) {
      lines.push(`- ${s.sourceId}  [${s.coordinateSpace}]  ${s.path}  (${shortHash(s.sourceHash)})`);
    }
  }

  lines.push('', `## Exports (${data.exports.page.returned}/${data.exports.page.total}, providedKnown=${data.exports.providedExportsKnown})`);
  lines.push(fmtTable(
    ['exportPath', 'compilerUsage', 'inRefs'],
    data.exports.items.map(e => [fmtExport(e.exportPath), e.compilerUsage, e.incomingReferences ?? 'unknown']),
    new Set([2]),
  ));
  if (data.exports.page.nextCursor) lines.push(`more exports: --cursor ${data.exports.page.nextCursor}`);

  lines.push('', 'hint:');
  lines.push(`- read code + coverage:  source --module ${data.moduleId}`);
  lines.push(`- unexecuted hot lines:  source --module ${data.moduleId} --unexecuted`);
  lines.push(`- all use sites + code:  refs --module ${data.moduleId}`);
  return lines.join('\n');
}

function fmtSource(data) {
  if (data.mode === 'lines') {
    const lines = [`# Coverage Lines: ${data.modulePath} (${data.moduleId}, mapped-lines-only, showing ${data.page.returned}/${data.page.total})`];
    lines.push('', fmtTable(
      ['line', 'state', 'unexec', 'loaded', 'code'],
      data.items.map(item => [
        item.line, item.runtimeState,
        fmtBytes(item.generated?.unexecutedBytes),
        fmtBytes(item.generated?.loadedBytes),
        item.code ?? '-',
      ]),
      new Set([0, 2, 3]),
    ));
    if (data.page.nextCursor) lines.push('', `next page: --cursor ${data.page.nextCursor}`);
    if (data.items.length) {
      lines.push(`hint: read surrounding code with \`source --module ${data.moduleId} --line ${Math.max(1, data.items[0].line - 5)}\``);
    }
    return lines.join('\n');
  }

  const lines = [`# Source ${data.sourceId}${data.moduleId ? ` (${data.moduleId})` : ''}`];
  lines.push(`path: ${data.path}  space: ${data.coordinateSpace}  hash: ${shortHash(data.sourceHash)}  unit: ${data.coordinateUnit}`);
  lines.push(`window: ${data.start.line}:${data.start.column} .. ${data.end.line}:${data.end.column} (of ${data.totalLines} lines, ${data.content.length.toLocaleString('en-US')} / ${data.totalCharacters.toLocaleString('en-US')} chars)`);
  lines.push('');

  const covMap = data._coverageByLine || (data.coverage ? new Map(data.coverage.items.map(i => [i.line, i])) : null);
  const codeLines = data.content.split('\n');
  // Avoid trailing phantom empty line when content ends with '\n'.
  if (codeLines.length > 1 && codeLines.at(-1) === '') codeLines.pop();
  const width = Math.max(3, String(data.start.line + codeLines.length).length);
  const tagFor = cov => {
    if (!cov) return '-'.padEnd(13);
    if (cov.runtimeState === 'executed') return `EXEC ${fmtBytes(cov.executedBytes).padStart(7)} `.slice(0, 13);
    if (cov.runtimeState === 'unexecuted') return `UNEX ${fmtBytes(cov.unexecutedBytes).padStart(7)} `.slice(0, 13);
    if (cov.runtimeState === 'not-loaded') return 'NOT-LOAD     ';
    return 'UNKNOWN      ';
  };

  let bodyBytes = Buffer.byteLength(lines.join('\n'));
  let stoppedEarly = false;
  for (let i = 0; i < codeLines.length; i++) {
    const lineNo = data.start.line + i;
    const raw = codeLines[i].endsWith('\r') ? codeLines[i].slice(0, -1) : codeLines[i];
    const row = covMap
      ? `${String(lineNo).padStart(width)} | ${tagFor(covMap.get(lineNo))} | ${raw}`
      : `${String(lineNo).padStart(width)} | ${raw}`;
    const sz = Buffer.byteLength(row) + 1;
    if (bodyBytes + sz > 30 * 1024 && i > 0) {
      stoppedEarly = true;
      lines.push(`... (output truncated to 32 KiB budget at line ${lineNo}; continue with --line ${lineNo} --characters 2000)`);
      break;
    }
    lines.push(row);
    bodyBytes += sz;
  }
  if (!stoppedEarly && data.next) {
    lines.push('', `next window: --line ${data.next.line} --column ${data.next.column}`);
  }
  return lines.join('\n');
}

function fmtMappingBlock(mapping, indent = '   ', detailed = false) {
  const out = [];
  if (!mapping) return out;
  if (mapping.candidates?.length) {
    if (mapping.gap) out.push(`${indent}gap: ${mapping.gap}`);
    mapping.candidates.forEach((cand, idx) => {
      const rec = cand.sourceIdentity?.matchesCapturedResource ? ' (matchesCapturedResource=true)' : '';
      out.push(`${indent}Candidate ${idx + 1} [${fmtSpaceTag(cand)}]${rec}: ${cand.sourcePath}:${fmtLoc(cand.sourceLocation)}  owner: ${fmtOwners(cand.ownerChain, detailed)}`);
      if (cand.gap) out.push(`${indent}  gap: ${cand.gap}`);
      if (cand.snippet) out.push(fmtSnippet(cand.snippet, cand.sourceLocation, `${indent}  `));
    });
    return out;
  }
  if (mapping.gap) out.push(`${indent}gap: ${mapping.gap}`);
  if (mapping.astGap) out.push(`${indent}astGap: ${mapping.astGap}`);
  if (mapping.snippet) out.push(fmtSnippet(mapping.snippet, mapping.sourceLocation, indent));
  return out;
}

function fmtRefs(data) {
  if (data.mode === 'edges') {
    const lines = [];
    for (const { edge, mapping } of data.items) {
      if (lines.length) lines.push('');
      lines.push(`# Reference ${edge.edgeId}`);
      lines.push(`edge: ${edge.originPath || edge.originModuleId} (${edge.originModuleId}) ${fmtExport(edge.originExport)}`);
      lines.push(`   -> ${edge.targetPath || edge.targetModuleId} (${edge.targetModuleId}) ${fmtExport(edge.targetExport)}`);
      lines.push(`relation: ${edge.relationEvidence}${edge.dependencyType ? ` (${edge.dependencyType})` : ''}${edge.active !== null ? ` | active: ${edge.active}` : ''} | rawLoc: ${typeof edge.rawLocation === 'string' ? edge.rawLocation : JSON.stringify(edge.rawLocation)}`);
      if (mapping.candidates?.length) {
        lines.push(...fmtMappingBlock(mapping, '', true));
        lines.push(`re-query: refs --edge ${edge.edgeId} --space post-loader   # or --space resource`);
      } else {
        lines.push(`location: ${mapping.sourcePath || '?'}:${fmtLoc(mapping.sourceLocation)} [${fmtSpaceTag(mapping)}]  precision: ${mapping.locationPrecision}`);
        lines.push(`owner: ${fmtOwners(mapping.ownerChain, true)}`);
        lines.push(...fmtMappingBlock(mapping, '', true));
        if (mapping.sourceQuery) {
          const sq = mapping.sourceQuery;
          const mapFlag = sq['map-source'] ? ` --map-source ${JSON.stringify(sq['map-source'])}` : '';
          lines.push(`full source: source --module ${sq.module} --source ${sq.source}${mapFlag} --line ${Math.max(1, (mapping.sourceLocation?.start?.line || 1) - 10)}`);
        }
      }
    }
    if (data.returned < data.totalRequested) lines.push('', `(budget reached: returned ${data.returned}/${data.totalRequested} edges; query remaining IDs separately)`);
    return lines.join('\n');
  }

  // Mode A: module refs grouped by export, with mapped source coordinates + snippets!
  const dirLabel = data.direction === 'in' ? 'IN ->' : 'OUT <-';
  const ctxLabel = data.contextLines === null ? 'no-code' : `context=${data.contextLines}`;
  const lines = [`# Refs ${dirLabel} ${data.modulePath} (${data.moduleId}, showing ${data.page.returned}/${data.page.total}, ${ctxLabel})`];
  if (!data.items.length) {
    lines.push('', '(no captured references matching filter)');
    return lines.join('\n');
  }

  // Group by targetExport (for incoming) or originExport (for outgoing), ordering named exports first, then module-level, then module-graph.
  const groups = new Map();
  const rankOf = key => key.startsWith('Export ') ? 0 : key === 'Module-level / namespace' ? 1 : 2;
  for (const item of data.items) {
    const keyExport = data.direction === 'in' ? item.targetExport : item.originExport;
    const isNamed = Array.isArray(keyExport) && keyExport.length > 0;
    const groupKey = isNamed ? `Export ${JSON.stringify(keyExport)}`
      : item.relationEvidence === 'module-graph' ? 'Module-graph references'
      : 'Module-level / namespace';
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => rankOf(a[0]) - rankOf(b[0]));

  let idx = 0;
  for (const [groupName, items] of orderedGroups) {
    lines.push('', `## ${groupName} (${items.length})`);
    for (const item of items) {
      idx++;
      const m = item.mapping;
      const originPath = item.originPath || item.originModuleId;
      const targetPath = item.targetPath || item.targetModuleId;
      const locStr = m?.sourceLocation ? `${m.sourcePath || originPath}:${fmtLoc(m.sourceLocation)}`
        : `${originPath} (rawLoc=${typeof item.rawLocation === 'string' ? item.rawLocation : JSON.stringify(item.rawLocation)})`;
      const ownerStr = m?.ownerChain ? `  owner: ${fmtOwners(m.ownerChain)}` : '';
      const tag = m ? `  (${fmtSpaceTag(m)})` : '';
      if (data.direction === 'in') {
        const exportStr = item.relationEvidence === 'native'
          ? `  originExport: ${fmtExport(item.originExport)}`
          : `  rel: ${item.dependencyType || item.relationEvidence}`;
        lines.push(`${idx}. [${item.edgeId}] ${locStr}${ownerStr}${exportStr}${tag}`);
        lines.push(`   peer: ${item.originModuleId}`);
      } else {
        const relStr = item.relationEvidence === 'native'
          ? `${targetPath} ${fmtExport(item.targetExport)}`
          : `${targetPath} (${item.dependencyType || item.relationEvidence})`;
        lines.push(`${idx}. [${item.edgeId}] -> ${relStr}  at ${locStr}${ownerStr}${tag}`);
        lines.push(`   target: ${item.targetModuleId}`);
      }
      const block = fmtMappingBlock(m, '   ', false);
      if (block.length) lines.push(...block);
    }
  }

  lines.push('');
  if (data.page.nextCursor) lines.push(`next page: --cursor ${data.page.nextCursor}`);
  lines.push(`hint: expand context with \`refs --edge <edgeId> --context 10\`, read full file with \`source --module <peerId> --line <line>\`, or trace upstream with \`chain --module ${data.moduleId} --export <name>\``);
  return lines.join('\n');
}

function fmtChain(data) {
  const lines = ['# Export Usage Chain'];
  lines.push(`root: ${data.root.path} (${data.root.moduleId}) :: ${fmtExport(data.root.exportPath)}`);
  lines.push(`stats: edges=${data.edges.length}  terminals=${data.terminals.length}  cycles=${data.cycles.length}  frontier=${data.frontier.length}  truncated=${data.truncated} (maxDepth=${data.maxDepth}, maxEdges=${data.maxEdges})`);

  const cycleEdges = new Set(data.cycles.map(c => c.edgeId));
  lines.push('', '## Edges (importer -> target)');
  if (!data.edges.length) {
    lines.push('(no captured incoming edges)');
  } else {
    data.edges.forEach((edge, i) => {
      const m = edge.mapping;
      const locStr = m?.sourceLocation ? `${fmtLoc(m.sourceLocation)} [${fmtSpaceTag(m)}]`
        : `raw ${typeof edge.rawLocation === 'string' ? edge.rawLocation : JSON.stringify(edge.rawLocation)}`;
      const cyc = cycleEdges.has(edge.edgeId) ? '  [CYCLE]' : '';
      const owner = m?.ownerChain ? `  owner: ${fmtOwners(m.ownerChain)}` : '';
      lines.push(`${i + 1}. [${edge.edgeId}] ${edge.originPath || edge.originModuleId} ${fmtExport(edge.originExport)} --(${locStr})--> ${edge.targetPath || edge.targetModuleId} ${fmtExport(edge.targetExport)}${owner}${cyc}`);
      if (m?.snippet) lines.push(fmtSnippet(m.snippet, m.sourceLocation, '   '));
      else if (m?.candidates?.length) {
        const best = m.candidates.find(c => c.sourceIdentity?.matchesCapturedResource) || m.candidates[0];
        if (best?.snippet) lines.push(fmtSnippet(best.snippet, best.sourceLocation, '   '));
      }
    });
  }

  if (data.terminals.length) {
    lines.push('', `## Terminals (${data.terminals.length})`);
    for (const t of data.terminals) {
      if (t.reason === 'no-named-origin-export') {
        lines.push(`- [no-named-origin-export] ${t.path || t.moduleId} (${t.moduleId}) via ${t.edgeId} -> \`refs --edge ${t.edgeId} --context 5\``);
      } else {
        lines.push(`- [${t.reason}] ${t.path || t.moduleId} (${t.moduleId}) :: ${fmtExport(t.exportPath)} -> \`refs --module ${t.moduleId} --direction in\``);
      }
    }
  }

  if (data.cycles.length) {
    lines.push('', `## Cycles (${data.cycles.length})`);
    for (const c of data.cycles) {
      lines.push(`- ${c.edgeId} -> ${c.path || c.moduleId} (${c.moduleId}) :: ${fmtExport(c.exportPath)}`);
    }
  }

  if (data.frontier.length) {
    lines.push('', `## Frontier (${data.frontier.length}, truncated)`);
    for (const f of data.frontier) {
      const q = f.query;
      const cur = q.cursor ? ` --cursor ${q.cursor}` : '';
      lines.push(`- [${f.reason}] ${f.path || f.moduleId} (${f.moduleId}) :: ${fmtExport(f.exportPath)}`);
      const safeExportPath = String(q['export-path']).replaceAll("'", "'\\''");
      lines.push(`  continue: refs --module ${q.module} --export-path '${safeExportPath}' --direction in --relation native${cur}`);
    }
  }

  if (data.modules?.length) {
    lines.push('', `## Modules in Chain (${data.modules.length})`);
    if (data.coverageAvailable === false) {
      lines.push(fmtTable(
        ['moduleId', 'path'],
        data.modules.map(m => [m.moduleId, m.path]),
      ));
    } else {
      lines.push(fmtTable(
        ['moduleId', 'path', 'loaded', 'exec%', 'unexec'],
        data.modules.map(m => [m.moduleId, m.path, m.loaded === null ? 'unknown' : m.loaded, fmtPct(m.executionRatio), fmtBytes(m.unexecutedBytes)]),
        new Set([3, 4]),
      ));
    }
  }
  return lines.join('\n');
}

function formatText(command, data) {
  if (command === 'help' || command === 'describe') return fmtHelp(data);
  if (command === 'index') return fmtIndex(data);
  if (command === 'status') return fmtStatus(data);
  if (command === 'chunks') return fmtChunks(data);
  if (command === 'modules') return fmtModules(data);
  if (command === 'module') return fmtModule(data);
  if (command === 'source') return fmtSource(data);
  if (command === 'refs') return fmtRefs(data);
  if (command === 'chain') return fmtChain(data);
  return JSON.stringify(data, null, 2);
}

function formatErrorText(error) {
  const lines = [`ERROR [${error.code || 'QUERY_FAILED'}]: ${error.message}`];
  if (error.details !== undefined) {
    if (error.details.fields) lines.push(`valid sort fields: ${error.details.fields.join(', ')}`);
    else if (error.details.supported) lines.push(`supported: ${error.details.supported.join(', ')}`);
    else if (error.details.availableSpaces) lines.push(`available spaces: ${error.details.availableSpaces.join(', ')}`);
    else if (error.details.commands) lines.push(`valid commands: ${error.details.commands.join(', ')}`);
    else lines.push(`details: ${JSON.stringify(error.details)}`);
  }
  return lines.join('\n');
}

module.exports = { formatText, formatErrorText, fmtBytes, fmtPct };

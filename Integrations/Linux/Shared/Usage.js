// Pure model shared by the QML frontend and offline Node tests.
function remaining(window) {
    if (!window || typeof window.usedPercent !== "number" || !isFinite(window.usedPercent)) return null;
    return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

function rows(text, showIdentity) {
    var decoded = JSON.parse(text);
    var entries = Array.isArray(decoded) ? decoded : [decoded];
    if (!entries.length || entries.some(function(e) { return !e || typeof e.provider !== "string"; }))
        throw new Error("Invalid usage response");
    return entries.map(function(entry, entryIndex) {
        var usage = entry.usage || {};
        var identity = usage.identity || {};
        var windows = [];
        ["primary", "secondary", "tertiary"].forEach(function(key, index) {
            var window = usage[key];
            var left = remaining(window);
            if (left === null) return;
            var minutes = window.windowMinutes;
            var label = minutes >= 1440 ? (minutes / 1440) + " day" :
                minutes > 0 ? (minutes / 60) + " hour" : ["Session", "Weekly", "Additional"][index];
            var pace = entry.pace && entry.pace[key] ? entry.pace[key] : null;
            windows.push({key: key, label: label, minutes: number(minutes), remaining: left,
                resetsAt: window.resetsAt || "", pace: pace ? String(pace.summary || "") : "",
                paceDelta: pace ? number(pace.deltaPercent) : null});
        });
        return {
            provider: entry.provider,
            failed: !!entry.error,
            accountLabel: showIdentity ? String(identity.accountEmail || usage.accountEmail || "") : "",
            accountNumber: entryIndex + 1,
            plan: String(identity.loginMethod || usage.loginMethod || ""),
            status: entry.status ? String(entry.status.description || entry.status.indicator || "Unknown") : "",
            statusLevel: entry.status ? String(entry.status.indicator || "unknown") : "unknown",
            details: Array.isArray(usage.details) ? usage.details.slice(0, 8).map(function(section) {
                return {title: String(section.title || ""), rows: (section.rows || []).slice(0, 24).map(function(row) {
                    return {label: String(row.label || ""), value: displayText(row.value, showIdentity),
                        secondaryValue: displayText(row.secondaryValue, showIdentity)};
                }), chart: chart(section.chart)};
            }) : [],
            source: entry.source || "",
            windows: windows,
            updatedAt: usage.updatedAt || "",
            credits: entry.credits && typeof entry.credits.remaining === "number" ? entry.credits.remaining : null,
            error: entry.error ? "Usage unavailable. Check this provider’s CodexBar login/configuration." :
                windows.length ? "" : "No quota windows reported."
        };
    });
}

function command(settings) {
    var provider = String(settings.provider || "codex");
    var args = ["timeout", "--kill-after=5", "60", String(settings.executable || "codexbar"),
        "usage", "--format", "json", "--json-only"];
    if (provider !== "enabled") args.push("--provider", provider);
    var source = String(settings.source || "auto");
    if (source !== "auto") args.push("--source", source);
    if (settings.showStatus !== false) args.push("--status");
    if (["enabled", "all", "both"].indexOf(provider) === -1) {
        if (settings.allAccounts === true) args.push("--all-accounts");
        else if (Number.isInteger(Number(settings.accountIndex)) && Number(settings.accountIndex) > 0)
            args.push("--account-index", String(settings.accountIndex));
    }
    return args;
}

function displayText(value, showIdentity) {
    var text = String(value || "").slice(0, 500);
    return showIdentity ? text : text.replace(/[^\s@]+@[^\s@]+/g, "[hidden email]");
}

function chart(value) {
    if (!value || !Array.isArray(value.points)) return null;
    var points = value.points.slice(0, 120).filter(function(point) {
        return point && typeof point.value === "number" && isFinite(point.value);
    }).map(function(point) { return {label: String(point.label || ""), value: point.value}; });
    return {title: String(value.title || ""), unit: String(value.unit || ""),
        kind: value.kind === "line" ? "line" : "bars", points: points};
}

function number(value) { return typeof value === "number" && isFinite(value) ? value : null; }

function money(value) { return number(value) === null ? "Unavailable" : "$" + value.toFixed(2); }

function count(value) {
    return number(value) === null ? "—" : Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function provenance(value) {
    return {listPriceEstimate: "List-price estimate", actual: "Reported cost", unknown: "Cost source unavailable"}[value] || value;
}

function costs(text, today) {
    if (!today) {
        var now = new Date();
        today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    }
    var decoded = JSON.parse(text);
    if (!Array.isArray(decoded) || decoded.some(function(row) { return !row || typeof row.provider !== "string"; }))
        throw new Error("Invalid cost response");
    return decoded.map(function(row) {
        var totals = row.totals || {};
        var daily = Array.isArray(row.daily) ? row.daily.slice(-30) : [];
        var todayRow = daily.find(function(day) { return day.date === today; });
        return {provider: row.provider, today: todayRow ? number(todayRow.totalCost) :
                row.historyCoverageIsEstablished === true && !row.error ? 0 : null, month: number(row.last30DaysCostUSD),
            tokens: number(row.last30DaysTokens), input: number(totals.inputTokens), output: number(totals.outputTokens),
            cached: number(totals.cacheReadTokens), provenance: String(row.provenance || "unknown"),
            coverage: row.historyCoverageIsEstablished === true ? "Local history" : "History may be incomplete",
            error: row.error ? "Local cost history unavailable" : "",
            chart: chart({title: "Recorded daily cost · USD", unit: "USD", kind: "bars",
                points: daily.map(function(day) { return {label: day.date, value: day.totalCost}; })})};
    });
}

function providerTag(provider) {
    return provider === "codex" ? "CX" : provider === "claude" ? "CL" : provider;
}

function summary(entries, mode) {
    var label = entries.slice(0, 2).map(function(entry) {
        return providerTag(entry.provider) + " " +
            (entry.windows.length ? quotaValue(entry.windows[0].remaining, mode) + "%" : "—");
    }).join("  ·  ");
    return label + (entries.length > 2 ? "  +" + (entries.length - 2) : "");
}

// Lane detection mirrors Core's ProviderUsagePresentation.standardSemanticWindows so the bar
// follows the reported window cadence instead of a provider name or a slot position.
function sessionWindow(windows) {
    return windows.filter(function(item) { return item.minutes >= 60 && item.minutes <= 720; })[0] || null;
}

function weeklyWindow(windows) {
    return windows.filter(function(item) { return item.minutes === 10080; })[0] || null;
}

// Compact cadence label: 10080 -> "7D", 300 -> "5H".
function laneLabel(minutes) {
    if (!minutes || minutes <= 0) return "";
    if (minutes % 1440 === 0) return (minutes / 1440) + "D";
    if (minutes % 60 === 0) return (minutes / 60) + "H";
    return minutes + "M";
}

// Mirrors MenuBarDisplayText.paceText: positive is a deficit, negative is a reserve.
// An unavailable pace stays unavailable; it is never reported as being on pace.
function paceDeltaText(delta) {
    if (number(delta) === null) return "—";
    var value = Math.round(Math.abs(delta));
    return value === 0 ? "0%" : (delta >= 0 ? "+" : "-") + value + "%";
}

function laneSegments(entry, mode) {
    var windows = entry.windows || [];
    var session = sessionWindow(windows);
    var weekly = weeklyWindow(windows);
    var segments = [];
    if (session) segments.push(laneLabel(session.minutes) + " " + quotaValue(session.remaining, mode) + "%");
    // Pace belongs to the weekly window, not to whichever lane is most constrained.
    if (weekly) segments.push(laneLabel(weekly.minutes) + " " + quotaValue(weekly.remaining, mode) + "%",
        paceDeltaText(weekly.paceDelta));
    if (segments.length || !windows.length) return segments;
    // A provider reporting neither cadence keeps its first window rather than going blank.
    return [(laneLabel(windows[0].minutes) || windows[0].label) + " " +
        quotaValue(windows[0].remaining, mode) + "%"];
}

// Persistent bar label. Absent lanes contribute no text and no separator.
function barLabel(entries, mode) {
    var shown = entries.slice(0, 2);
    var label = shown.map(function(entry) {
        var segments = laneSegments(entry, mode);
        return (shown.length > 1 ? providerTag(entry.provider) + " " : "") +
            (segments.length ? segments.join(" · ") : "—");
    }).join("  ·  ");
    return label + (entries.length > 2 ? "  +" + (entries.length - 2) : "");
}

function resetLabel(value, now) {
    var timestamp = Date.parse(value);
    if (!isFinite(timestamp)) return "Reset time unavailable";
    var minutes = Math.ceil((timestamp - now) / 60000);
    if (minutes <= 0) return "Reset due · refresh to update";
    if (minutes < 60) return "Resets in " + minutes + "m";
    if (minutes < 1440) return "Resets in " + Math.floor(minutes / 60) + "h " + minutes % 60 + "m";
    return "Resets in " + Math.floor(minutes / 1440) + "d " + Math.floor(minutes % 1440 / 60) + "h";
}

function providerName(id) {
    var names = {codex: "Codex", claude: "Claude", copilot: "GitHub Copilot", gemini: "Gemini",
        cursor: "Cursor", antigravity: "Antigravity", openrouter: "OpenRouter", kiro: "Kiro"};
    return names[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : "Unknown provider");
}

function quotaValue(remaining, mode) { return mode === "used" ? 100 - remaining : remaining; }

function resetText(timestamp, now, mode) {
    var date = new Date(timestamp);
    if (!timestamp || !isFinite(date.getTime())) return "Reset time unavailable";
    var absolute = date.toLocaleString();
    if (mode === "absolute") return "Resets " + absolute;
    if (mode === "both") return resetLabel(timestamp, now) + " · " + absolute;
    return resetLabel(timestamp, now);
}

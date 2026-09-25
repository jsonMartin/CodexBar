import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Presentation only. The standalone app owns settings, polling and notifications.
Panel {
    id: root
    moduleName: "steipete.codexbar"
    ipcTarget: moduleName
    property var snapshot: ({})
    property string response: ""
    property bool available: false
    readonly property string executable: String(setting("desktopExecutable", "codexbar-linux"))
    // Omarchy draws one layout on every monitor, so each instance hides itself on the outputs the
    // backend lists; the settings live in linux.json with the rest of the display preferences.
    readonly property string outputName: root.QsWindow.window && root.QsWindow.window.screen
        ? String(root.QsWindow.window.screen.name || "") : ""
    readonly property var hiddenOutputs: root.available && root.snapshot && root.snapshot.hiddenOutputs
        ? root.snapshot.hiddenOutputs : []
    readonly property bool hiddenHere: outputName !== "" && Array.prototype.indexOf.call(hiddenOutputs, outputName) !== -1
    visible: !hiddenHere
    implicitWidth: hiddenHere ? 0 : button.implicitWidth
    implicitHeight: button.implicitHeight
    function poll() { if (!reader.running) reader.running = true; }
    function launch(page) { Quickshell.execDetached([executable, "--" + page]); close(); }
    function refresh() { Quickshell.execDetached([executable, "--refresh"]); }
    function setHidden(name, hidden) {
        var next = Array.prototype.filter.call(hiddenOutputs, function(item) { return item !== name; });
        if (hidden) next.push(name);
        Quickshell.execDetached([executable, "--configure", JSON.stringify({hiddenOutputs: next})]);
        close();
        repoll.restart();
    }
    Timer { id: repoll; interval: 500; onTriggered: root.poll() }
    // Pace colors come from the theme's own palette. Omarchy's Color exposes only red (urgent), so
    // the widget reads colors.toml itself, falling back to the ANSI slots older themes use.
    property color paceBlue: Color.accent
    property color paceOrange: Color.urgent
    property color paceRed: Color.urgent
    function loadPalette(raw) {
        var found = {};
        String(raw || "").split("\n").forEach(function(line) {
            var match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/);
            if (match) found[match[1]] = match[2];
        });
        paceBlue = found.blue || found.color4 || Color.accent;
        paceOrange = found.orange || found.color3 || found.yellow || Color.urgent;
        paceRed = found.red || found.color1 || Color.urgent;
    }
    FileView {
        id: themeColors
        path: Color.currentThemePath + "/colors.toml"
        watchChanges: true; printErrors: false
        onFileChanged: reload()
        onLoaded: root.loadPalette(text())
        onLoadFailed: root.loadPalette("")
    }
    // A theme switch reaches Color over IPC and may not touch this path, so follow Color as well.
    Connections { target: Color; function onForegroundChanged() { themeColors.reload() } }
    // Diverging pace scale around Core's on-pace band (±6): reserve fades from `base` toward blue by
    // −25; a deficit is a warning from its first step, running orange to red by +25.
    function paceColor(delta, base) {
        if (typeof delta !== "number" || Math.abs(delta) <= 6) return base;
        var t = Math.min(1, (Math.abs(delta) - 6) / 19);
        var from = delta < 0 ? base : paceOrange, to = delta < 0 ? paceBlue : paceRed;
        return Qt.tint(from, Qt.rgba(to.r, to.g, to.b, t));
    }
    Component.onCompleted: Qt.callLater(poll)
    onSettingsChanged: Qt.callLater(poll)
    onOpenedChanged: if (opened) poll()
    Timer { interval: 5000; running: true; repeat: true; onTriggered: root.poll() }
    Process {
        id: reader
        command: [root.executable, "--snapshot"]
        stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.response = text }
        stderr: StdioCollector {}
        onExited: function(code) {
            try {
                var data = JSON.parse(root.response);
                if (code !== 0 || data.schemaVersion !== 1 || !Array.isArray(data.entries)) throw new Error("Unavailable");
                root.snapshot = data;
                root.available = true;
            } catch (error) { root.available = false; }
        }
    }
    WidgetButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        // One segment per displayed provider; older backends publish no barEntries and get the plain label.
        readonly property var segments: root.available && root.snapshot && Array.isArray(root.snapshot.barEntries)
            ? root.snapshot.barEntries : []
        readonly property bool icons: Array.isArray(segments) && segments.length > 0
        // The backend formats quota; the bar only prefixes stale data.
        text: !root.available ? "CodexBar —" : (root.snapshot.stale ? "! " : "") +
            (root.snapshot.summary || "CodexBar —")
        // The own label stays the tooltip fallback and the fallback renderer; icons replace it when present.
        labelVisible: !icons
        fixedWidth: icons ? badges.implicitWidth + scaledHorizontalMargin * 2 : -1
        // Heat moves the pace figure off the bar; the tooltip then spells out each warm lane.
        tooltipText: {
            var base = "CodexBar · quota " + (root.snapshot.quotaDisplay || "remaining") +
                "\nClick for usage · middle-click to refresh"
            var lines = segments.map(function(entry) { return entry && entry.hint ? entry.hint : ""; })
                .filter(function(line) { return line !== ""; })
            return lines.length ? base + "\n" + lines.join("\n") : base
        }
        onPressed: function(code) { if (code === Qt.MiddleButton) root.refresh(); else root.toggle(); }
        Row {
            id: badges
            anchors.centerIn: parent
            visible: button.icons
            spacing: Style.space(4)
            Text {
                visible: root.snapshot.stale === true
                text: "!"
                color: button.foreground
                font.family: button.fontFamily; font.pixelSize: button.fontSize
                anchors.verticalCenter: parent.verticalCenter
            }
            Repeater {
                model: button.segments
                Row {
                    id: segment
                    required property var modelData
                    required property int index
                    spacing: Style.space(4)
                    Text {
                        visible: segment.index > 0
                        text: "·"
                        color: button.foreground; opacity: 0.55
                        font.family: button.fontFamily; font.pixelSize: button.fontSize
                        anchors.verticalCenter: parent.verticalCenter
                    }
                    Item {
                        id: badge
                        // A provider without an installed logo keeps its text tag instead of a gap.
                        readonly property url icon: modelData && modelData.provider
                            ? Qt.resolvedUrl("icons/ProviderIcon-" + modelData.provider + ".svg") : ""
                        readonly property bool loaded: badgeIcon.status === Image.Ready
                        // In compact mode the entry delta is the provider's hottest lane: the mark
                        // takes its color, while the percentage beside it keeps its own lane's.
                        readonly property color tint: root.paceColor(modelData ? modelData.delta : null, button.foreground)
                        // Size to whichever child is drawn. Taking the larger of the two
                        // reserved the hidden tag's width, which is the full provider id for
                        // anything without a short tag, leaving a gap beside the logo.
                        implicitWidth: badge.loaded ? badgeIcon.width : badgeTag.implicitWidth
                        implicitHeight: badge.loaded ? badgeIcon.height : badgeTag.implicitHeight
                        width: implicitWidth; height: implicitHeight
                        anchors.verticalCenter: parent.verticalCenter
                        Image {
                            id: badgeIcon
                            anchors.verticalCenter: parent.verticalCenter
                            source: badge.icon
                            // Without sourceSize the 100x100 SVGs rasterise at natural size and look soft.
                            // A logo needs more than cap height to read at bar size, so it runs a
                            // quarter larger than the text it labels and stays centred on it.
                            readonly property int extent: Math.round(button.fontSize * 1.5)
                            sourceSize: Qt.size(extent, extent)
                            visible: false
                        }
                        MultiEffect {
                            anchors.fill: badgeIcon
                            source: badgeIcon
                            visible: badge.loaded
                            // Colorization scales each pixel's luminance, so a logo drawn in black
                            // would stay black. Flatten every pixel to white first, keeping only the
                            // alpha, so each mark becomes an exact tint of the bar's foreground.
                            contrast: -1.0
                            brightness: 0.5
                            colorization: 1.0
                            colorizationColor: badge.tint
                        }
                        Text {
                            id: badgeTag
                            visible: !badge.loaded
                            text: modelData && modelData.tag ? modelData.tag : ""
                            textFormat: Text.PlainText
                            color: badge.tint
                            font.family: button.fontFamily; font.pixelSize: button.fontSize
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }
                    Row {
                        id: quota
                        // Heat colors each quota lane by how fast its window burns. Without any heat,
                        // or from an older backend without parts, the joined text draws exactly as before.
                        // A Repeater's modelData hands nested arrays over as sequence wrappers, which
                        // Array.isArray rejects, so test for a length instead.
                        readonly property var parts: modelData && modelData.parts && modelData.parts.length &&
                            Array.prototype.some.call(modelData.parts, function(p) { return p && p.heat !== null && p.heat !== undefined; })
                            ? modelData.parts : null
                        Text {
                            visible: quota.parts === null
                            text: modelData && modelData.text ? modelData.text : ""
                            color: button.foreground
                            font.family: button.fontFamily; font.pixelSize: button.fontSize
                            textFormat: Text.PlainText
                            anchors.verticalCenter: parent.verticalCenter
                        }
                        Repeater {
                            model: quota.parts || []
                            Row {
                                id: part
                                required property var modelData
                                required property int index
                                // Only a hot lane also gains weight.
                                readonly property bool scorching: !!part.modelData && part.modelData.heat === 3
                                // The joined text's own separator, so lanes stay distinct from the
                                // dimmed mark between providers.
                                Text {
                                    visible: part.index > 0
                                    text: " · "
                                    color: button.foreground
                                    font.family: button.fontFamily; font.pixelSize: button.fontSize
                                    anchors.verticalCenter: parent.verticalCenter
                                }
                                Text {
                                    text: part.modelData && part.modelData.text ? part.modelData.text : ""
                                    color: root.paceColor(part.modelData ? part.modelData.delta : null, button.foreground)
                                    font.bold: part.scorching
                                    font.family: button.fontFamily; font.pixelSize: button.fontSize
                                    textFormat: Text.PlainText
                                    anchors.verticalCenter: parent.verticalCenter
                                }
                            }
                        }
                    }
                }
            }
            Text {
                // The joined label that carries this count is hidden while marks are drawn, so
                // the providers beyond the bar's display limit are counted here instead.
                readonly property int extra: {
                    var total = root.available && root.snapshot && Array.isArray(root.snapshot.entries)
                        ? root.snapshot.entries.length : 0
                    var shown = Array.isArray(button.segments) ? button.segments.length : 0
                    return total - shown
                }
                visible: extra > 0
                text: "+" + extra
                color: button.foreground
                font.family: button.fontFamily; font.pixelSize: button.fontSize
                anchors.verticalCenter: parent.verticalCenter
            }
        }
    }
    KeyboardPanel {
        id: popup
        anchorItem: button; owner: root; bar: root.bar; open: root.opened
        focusTarget: keys
        contentWidth: fittedContentWidth(Style.space(330))
        // Grow to the screen before scrolling; the panel caps itself at the available height.
        contentHeight: fittedContentHeight(content.implicitHeight)
        FocusScope {
            id: keys
            anchors.fill: parent
            Keys.onEscapePressed: root.close()
            Keys.onPressed: function(event) { if (event.key === Qt.Key_R) root.refresh(); }
            Flickable {
                anchors.fill: parent; clip: true
                contentHeight: content.implicitHeight; contentWidth: width
                Column {
                    id: content
                    width: parent.width; spacing: Style.space(12)
                    Caption { text: "CodexBar"; font.bold: true; font.pixelSize: Style.font.heading }
                    Caption {
                        text: !root.available ? "Open CodexBar to start background refresh." : root.snapshot.error ||
                            (root.snapshot.busy ? "Refreshing…" : "Updated " + root.snapshot.updated + (root.snapshot.stale ? " · older data" : ""))
                    }
                    Repeater {
                        model: root.available ? root.snapshot.entries : []
                        Column {
                            required property var modelData
                            width: content.width; spacing: Style.space(6)
                            Caption { text: modelData.provider.toUpperCase(); font.bold: true }
                            Caption { text: modelData.error; visible: text !== "" }
                            Repeater {
                                model: modelData.windows
                                Column {
                                    id: lane
                                    required property var modelData
                                    width: content.width; spacing: Style.space(4)
                                    readonly property real value: modelData.displayValue === undefined ? modelData.remaining : modelData.displayValue
                                    readonly property bool hasExpected: modelData.expectedDisplay !== null && modelData.expectedDisplay !== undefined
                                    // Only a window burning ahead of its elapsed share has a deficit
                                    // gap to draw; heat 1..3 implies that even without a CLI delta.
                                    readonly property bool overPace: (typeof modelData.delta === "number" && modelData.delta > 0) ||
                                        (typeof modelData.paceDelta === "number" && modelData.paceDelta > 0)
                                    // Heat decides whether the lane is colored at all; null keeps it neutral.
                                    readonly property var colorDelta: modelData.heat !== null && modelData.heat !== undefined &&
                                        typeof modelData.delta === "number" ? modelData.delta : null
                                    Row {
                                        width: parent.width; spacing: Style.space(6)
                                        Caption {
                                            id: quotaLabel
                                            // The eta shares the lane's one line and yields to the quota
                                            // by eliding, so the percentage is never the part cut off.
                                            width: Math.min(implicitWidth, parent.width)
                                            wrapMode: Text.NoWrap; elide: Text.ElideRight
                                            text: lane.modelData.label + " · " + lane.value + "% " + (lane.modelData.displaySuffix || "left")
                                        }
                                        Caption {
                                            id: eta
                                            // The backend blanks eta unless pace data survives for the window.
                                            visible: (lane.modelData.eta || "") !== ""
                                            width: Math.max(0, parent.width - quotaLabel.width - parent.spacing)
                                            wrapMode: Text.NoWrap; elide: Text.ElideRight
                                            horizontalAlignment: Text.AlignRight
                                            text: lane.modelData.eta || ""
                                            opacity: 0.7
                                            color: root.paceColor(lane.colorDelta, Color.foreground)
                                            font.bold: lane.modelData.heat === 3
                                        }
                                    }
                                    Item {
                                        width: parent.width; height: Style.space(5)
                                        readonly property real expected: lane.hasExpected ? lane.modelData.expectedDisplay : lane.value
                                        Rectangle {
                                            width: parent.width; height: parent.height; radius: height / 2
                                            color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.15)
                                        }
                                        // Where the window "should" be by now, drawn under the real fill.
                                        Rectangle {
                                            visible: lane.hasExpected
                                            width: parent.width * parent.expected / 100; height: parent.height; radius: height / 2
                                            color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.25)
                                        }
                                        Rectangle {
                                            width: parent.width * lane.value / 100; height: parent.height; radius: height / 2
                                            color: lane.modelData.warning ? Color.urgent : Color.accent
                                        }
                                        // Over the fill, so the overspend also shows in used mode, where it
                                        // lies inside the fill rather than beyond it.
                                        Rectangle {
                                            // Colored lanes show a gap on either side of pace; neutral ones only overspend.
                                            visible: lane.hasExpected && (lane.colorDelta !== null ? Math.abs(lane.colorDelta) > 6 : lane.overPace)
                                            x: parent.width * Math.min(lane.value, parent.expected) / 100
                                            width: parent.width * Math.abs(lane.value - parent.expected) / 100
                                            height: parent.height; radius: height / 2
                                            readonly property color tone: root.paceColor(lane.colorDelta, Color.foreground)
                                            color: lane.colorDelta !== null ? Qt.rgba(tone.r, tone.g, tone.b, 0.85)
                                                : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.35)
                                        }
                                        Rectangle {
                                            visible: lane.hasExpected
                                            x: parent.width * parent.expected / 100 - 1
                                            width: 2; height: parent.height + Style.space(4); radius: 1
                                            anchors.verticalCenter: parent.verticalCenter
                                            color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.8)
                                        }
                                    }
                                    Row {
                                        width: parent.width; spacing: Style.space(6)
                                        Caption {
                                            id: resetLabel
                                            width: Math.min(implicitWidth, parent.width)
                                            wrapMode: Text.NoWrap; elide: Text.ElideRight
                                            text: lane.modelData.resetText || "Reset time unavailable"
                                            opacity: 0.65
                                        }
                                        Caption {
                                            // The pace delta rides the reset line's free end, so keeping the
                                            // percentage costs no height. It shares the eta's staleness gate.
                                            readonly property var delta: !lane.hasExpected ? null
                                                : typeof lane.modelData.delta === "number" ? lane.modelData.delta
                                                : typeof lane.modelData.paceDelta === "number" ? Math.round(lane.modelData.paceDelta) : null
                                            visible: delta !== null
                                            width: Math.max(0, parent.width - resetLabel.width - parent.spacing)
                                            wrapMode: Text.NoWrap; elide: Text.ElideRight
                                            horizontalAlignment: Text.AlignRight
                                            text: delta === null ? "" : delta === 0 ? "On pace"
                                                : Math.abs(delta) + "% " + (delta > 0 ? "over" : "under") + " pace"
                                            opacity: 0.7
                                            color: eta.color
                                            font.bold: eta.font.bold
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Row {
                        spacing: Style.space(4)
                        Button { text: "Usage & Spend…"; focusable: true; onClicked: root.launch("usage") }
                        Button { text: "Settings…"; focusable: true; onClicked: root.launch("settings") }
                    }
                    Button { text: "Refresh"; focusable: true; enabled: root.available && !root.snapshot.busy; onClicked: root.refresh() }
                    Flow {
                        width: content.width; spacing: Style.space(4)
                        visible: root.available && root.outputName !== ""
                        Button {
                            text: "Hide on " + root.outputName; focusable: true
                            onClicked: root.setHidden(root.outputName, true)
                        }
                        // A monitor that hides the widget has no dropdown of its own, so it is
                        // brought back from here or from Settings.
                        Repeater {
                            model: Array.prototype.filter.call(root.hiddenOutputs, function(name) { return name !== root.outputName; })
                            Button {
                                required property var modelData
                                text: "Show on " + modelData; focusable: true
                                onClicked: root.setHidden(modelData, false)
                            }
                        }
                    }
                }
            }
        }
    }
    component Caption: Text {
        width: parent.width; color: Color.foreground; font.family: Style.font.family
        font.pixelSize: Style.font.body; textFormat: Text.PlainText; wrapMode: Text.Wrap
    }
}

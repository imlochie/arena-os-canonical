// ===========================================================================
// LOCHIE COLLEGE — CAMPUS
// ===========================================================================
// The phone surface. You arrive, you understand where the College is, you
// begin. Everything administrative lives in the desktop Control Room and the
// API refuses it from here anyway.
//
// The organising rule is inherited from the web Campus and matters more on a
// phone than anywhere else: NOT EVERY DAY NEEDS EVERY SECTION. A screen that
// always shows seven cards teaches you to ignore all seven. Sections here
// appear only when the College has something to say, so when something does
// appear, it means something.
//
// Every sentence displayed is the server's. This client computes no
// accountability, no rhythm, no interpretation — otherwise the phone becomes
// a second institution that can disagree with the first.
// ===========================================================================

import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  CollegeError,
  fetchBriefing,
  forgetDevice,
  getToken,
  pair,
  type Briefing,
} from "./lib/college";

const C = {
  bg: "#0b0f17",
  card: "#111827",
  line: "#1a2333",
  edge: "#243044",
  text: "#e2e8f0",
  dim: "#94a3b8",
  faint: "#64748b",
  ghost: "#475569",
  blue: "#1d4ed8",
  amber: "#fbbf24",
  amberBg: "#1a1408",
  amberEdge: "#78350f",
};

const CONTINUITY: Record<string, string> = {
  no_history: "#64748b",
  normal: "#22c55e",
  short_absence: "#38bdf8",
  extended_absence: "#f59e0b",
  long_absence: "#fb923c",
};

function Section({ title, tint, children }: { title: string; tint?: string; children: React.ReactNode }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 18, paddingBottom: 4 }}>
      <Text style={{ fontSize: 10, letterSpacing: 1.5, color: tint ?? C.ghost, fontWeight: "700", marginBottom: 9 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pairing screen
// ---------------------------------------------------------------------------

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [base, setBase] = useState("https://");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await pair(base, code.trim().toUpperCase(), "iPhone");
      onPaired();
    } catch (e) {
      setErr(e instanceof CollegeError ? `${e.message}${e.note ? `\n\n${e.note}` : ""}` : String(e));
    }
    setBusy(false);
  };

  const input = {
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.edge,
    borderRadius: 10,
    color: C.text,
    padding: 14,
    fontSize: 16,
    marginTop: 8,
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 22, paddingTop: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 24, color: C.text, fontWeight: "600" }}>🏛 Lochie College</Text>
      <Text style={{ fontSize: 14, color: C.dim, marginTop: 10, lineHeight: 21 }}>
        This device is not yet a recognised surface of the College.
      </Text>
      <Text style={{ fontSize: 13, color: C.faint, marginTop: 14, lineHeight: 20 }}>
        Open the Control Room on your desktop, generate a pairing code, and type it below within ten minutes.
      </Text>

      <Text style={{ fontSize: 11, color: C.ghost, marginTop: 24, letterSpacing: 1 }}>COLLEGE ADDRESS</Text>
      <TextInput
        style={input}
        value={base}
        onChangeText={setBase}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://college.example.com"
        placeholderTextColor={C.ghost}
      />

      <Text style={{ fontSize: 11, color: C.ghost, marginTop: 18, letterSpacing: 1 }}>PAIRING CODE</Text>
      <TextInput
        style={[input, { fontSize: 22, letterSpacing: 3, textAlign: "center" }]}
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="XXXX-XXXX"
        placeholderTextColor={C.ghost}
      />

      {err && (
        <View style={{ marginTop: 18, padding: 14, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberEdge, borderRadius: 10 }}>
          <Text style={{ color: "#fca5a5", fontSize: 13, lineHeight: 20 }}>{err}</Text>
        </View>
      )}

      <Pressable
        onPress={submit}
        disabled={busy || code.length < 4}
        style={{
          marginTop: 24,
          padding: 16,
          backgroundColor: code.length < 4 ? C.card : C.blue,
          borderRadius: 10,
          alignItems: "center",
        }}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "600", fontSize: 16 }}>Pair this device</Text>}
      </Pressable>

      <Text style={{ fontSize: 11, color: C.ghost, marginTop: 18, lineHeight: 18 }}>
        The token is stored in the iOS keychain. This device will be able to read College state, run sessions, record
        commitments and capture evidence — but never edit curriculum, timetable or faculty. Those stay in the Control Room.
      </Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Campus
// ---------------------------------------------------------------------------

function Campus({ onUnpair }: { onUnpair: () => void }) {
  const [b, setB] = useState<Briefing | null>(null);
  const [err, setErr] = useState<CollegeError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setB(await fetchBriefing());
      setErr(null);
    } catch (e) {
      setErr(e instanceof CollegeError ? e : new CollegeError(String(e), 0));
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator color={C.dim} />
        <Text style={{ color: C.faint, marginTop: 12, fontSize: 13 }}>Resolving institutional state…</Text>
      </View>
    );
  }

  if (err || !b) {
    const unpaired = err?.status === 401;
    return (
      <ScrollView contentContainerStyle={{ padding: 22 }}>
        <Text style={{ color: "#fca5a5", fontSize: 16, fontWeight: "600" }}>
          {unpaired ? "This device is no longer paired." : "The College could not be reached."}
        </Text>
        <Text style={{ color: C.dim, fontSize: 13, marginTop: 10, lineHeight: 20 }}>{err?.message}</Text>
        {!!err?.note && <Text style={{ color: C.faint, fontSize: 12, marginTop: 10, lineHeight: 19 }}>{err.note}</Text>}
        <Pressable onPress={unpaired ? onUnpair : load} style={{ marginTop: 22, padding: 15, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge, borderRadius: 10, alignItems: "center" }}>
          <Text style={{ color: C.dim, fontSize: 14 }}>{unpaired ? "Pair again" : "Try again"}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const tint = CONTINUITY[b.behaviour.continuity] ?? C.faint;
  const acc = b.accountability;
  const ext = b.matters.external;

  // The same epistemic gates as the web Campus.
  const showChanged = b.changed.materialCount > 0 || b.behaviour.depth !== "quick_orientation";
  const showAcc = acc.made > 0;
  const showExt = ext.known && ext.commitments.length > 0;
  const showMatters = b.matters.governance.length > 0 || b.matters.conditions.length > 0;
  const showGoals = b.temporal.goals.length > 0;
  const allQuiet = !showChanged && !showAcc && !showExt && !showMatters;

  return (
    <ScrollView
      contentContainerStyle={{ padding: 18, paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.faint} />}
    >
      <Text style={{ fontSize: 22, color: C.text, fontWeight: "600", letterSpacing: -0.4 }}>🏛 LOCHIE COLLEGE</Text>
      <Text style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>{b.where.longDate}</Text>
      <Text style={{ fontSize: 13, color: C.faint }}>{b.where.time} {b.where.timezone}</Text>

      <Section title="CURRENT POSITION" tint={tint}>
        <Text style={{ fontSize: 19, fontWeight: "600", color: tint }}>
          {b.temporal.sinceLastInteraction.label === "today"
            ? "Here today"
            : `${b.temporal.sinceLastInteraction.label} since you were last here`}
        </Text>
        <Text style={{ fontSize: 12.5, color: C.dim, marginTop: 6, lineHeight: 19 }}>{b.behaviour.reason}</Text>
      </Section>

      {showChanged && (
        <Section title="SINCE YOU WERE LAST HERE">
          <Text style={{ fontSize: 13.5, color: b.changed.materialCount ? C.text : C.faint, lineHeight: 20 }}>
            {b.changed.summary}
          </Text>
          {b.changed.items.slice(0, 8).map((c, i) => (
            <View key={i} style={{ marginTop: 9, paddingLeft: 11, borderLeftWidth: 2, borderLeftColor: C.edge }}>
              <Text style={{ fontSize: 13, color: C.text, lineHeight: 19 }}>{c.what}</Text>
              <Text style={{ fontSize: 10.5, color: C.ghost, marginTop: 2 }}>{c.when}</Text>
            </View>
          ))}
        </Section>
      )}

      {showAcc && (
        <Section title="ACCOUNTABILITY" tint={acc.quiet ? C.ghost : C.amber}>
          <Text style={{ fontSize: 13.5, color: C.text, lineHeight: 20 }}>{acc.summary}</Text>
          <Text style={{ fontSize: 12, color: C.faint, marginTop: 7 }}>
            {acc.completed} / {acc.made} completed
            {acc.missed > 0 ? ` · ${acc.missed} missed` : ""}
            {acc.open > 0 ? ` · ${acc.open} open` : ""}
          </Text>
          <Text style={{ fontSize: 12, color: C.faint, marginTop: 3, lineHeight: 18 }}>{acc.rhythmNote}</Text>

          {acc.overdue.slice(0, 4).map((c) => (
            <View key={c.id} style={{ marginTop: 9, padding: 11, backgroundColor: "#131a26", borderWidth: 1, borderColor: C.edge, borderRadius: 8 }}>
              <Text style={{ fontSize: 13, color: C.text }}>{c.statement}</Text>
              <Text style={{ fontSize: 11.5, color: C.dim, marginTop: 3, lineHeight: 17 }}>{c.condition}</Text>
            </View>
          ))}

          {acc.patterns.map((p, i) => (
            <View key={i} style={{ marginTop: 11, padding: 13, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberEdge, borderRadius: 9 }}>
              <Text style={{ fontSize: 10, letterSpacing: 1.3, color: C.amber, fontWeight: "700" }}>PATTERN DETECTED</Text>
              <Text style={{ fontSize: 13, color: C.text, marginTop: 5, lineHeight: 19 }}>
                “{p.what}” — {p.occurrences} times in {p.windowDays} days.
              </Text>
              {p.statedReasons.length > 0 && (
                <Text style={{ fontSize: 11.5, color: C.dim, marginTop: 4 }}>Stated: {p.statedReasons.join("; ")}</Text>
              )}
              <Text style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 6, lineHeight: 18 }}>{p.response}</Text>
            </View>
          ))}
        </Section>
      )}

      {showExt && (
        <Section title="ACADEMIC CONTEXT">
          {ext.commitments.map((c) => (
            <View
              key={c.id}
              style={{
                marginTop: 8,
                padding: 12,
                backgroundColor: c.imminent ? C.amberBg : C.card,
                borderWidth: 1,
                borderColor: c.imminent ? C.amberEdge : "#1e293b",
                borderRadius: 8,
              }}
            >
              <Text style={{ fontSize: 13, color: C.text, fontWeight: "500" }}>{c.provider}</Text>
              <Text style={{ fontSize: 13, color: "#cbd5e1", marginTop: 1 }}>{c.title}</Text>
              <Text style={{ fontSize: 11.5, color: C.dim, marginTop: 4, lineHeight: 17 }}>{c.condition}</Text>
            </View>
          ))}
        </Section>
      )}

      {showMatters && (
        <Section title="WORTH KNOWING">
          {b.matters.governance.map((g, i) => (
            <View key={`g${i}`} style={{ marginTop: 8, padding: 12, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberEdge, borderRadius: 8 }}>
              <Text style={{ fontSize: 10, letterSpacing: 1.1, color: C.amber, fontWeight: "700" }}>
                {g.authorityRequired.toUpperCase()}
              </Text>
              <Text style={{ fontSize: 13, color: C.text, marginTop: 3, lineHeight: 19 }}>{g.what}</Text>
            </View>
          ))}
          {b.matters.conditions.map((c, i) => (
            <Text key={`c${i}`} style={{ fontSize: 12.5, color: C.dim, marginTop: 8, lineHeight: 19, paddingLeft: 11, borderLeftWidth: 2, borderLeftColor: C.edge }}>
              {c}
            </Text>
          ))}
        </Section>
      )}

      {showGoals && (
        <Section title="GOALS">
          {b.temporal.goals.map((g) => (
            <View key={g.id} style={{ marginTop: 7 }}>
              <Text style={{ fontSize: 13, color: C.text }}>
                {g.title} <Text style={{ color: C.ghost, fontSize: 11 }}>· {g.status}</Text>
              </Text>
              <Text style={{ fontSize: 11.5, color: g.underTimePressure ? C.amber : C.faint, marginTop: 2, lineHeight: 17 }}>
                {g.condition}
              </Text>
            </View>
          ))}
        </Section>
      )}

      {allQuiet && (
        <Section title="SINCE YOU WERE LAST HERE">
          <Text style={{ fontSize: 13.5, color: C.faint, lineHeight: 21 }}>
            No significant changes since your last session.
          </Text>
        </Section>
      )}

      <Section title="RIGHT NOW" tint={b.next.lifeActivity ? C.faint : "#38bdf8"}>
        <Text style={{ fontSize: 16, color: C.text, fontWeight: "500" }}>{b.where.currentActivity}</Text>
        {!!b.where.nextActivity && (
          <Text style={{ fontSize: 12.5, color: C.faint, marginTop: 3 }}>next — {b.where.nextActivity}</Text>
        )}
        <Text style={{ fontSize: 12.5, color: C.dim, marginTop: 8, lineHeight: 19 }}>{b.next.handoff}</Text>

        {/* The College does not invite you into a class during scheduled life. */}
        <Pressable
          style={{
            marginTop: 15,
            padding: 15,
            backgroundColor: b.next.classAvailable ? C.blue : C.card,
            borderWidth: 1,
            borderColor: b.next.classAvailable ? "#2563eb" : C.edge,
            borderRadius: 10,
            alignItems: "center",
          }}
        >
          <Text style={{ color: b.next.classAvailable ? "#fff" : C.dim, fontWeight: b.next.classAvailable ? "600" : "500", fontSize: b.next.classAvailable ? 15 : 13.5 }}>
            {b.next.classAvailable ? "BEGIN CLASS" : "Open the College anyway"}
          </Text>
        </Pressable>
      </Section>

      <Text style={{ fontSize: 10.5, color: "#3f4a5c", marginTop: 20, lineHeight: 17 }}>{b.note}</Text>

      <Pressable onPress={onUnpair} style={{ marginTop: 24, alignItems: "center" }}>
        <Text style={{ fontSize: 11, color: C.ghost }}>Unpair this device</Text>
      </Pressable>
    </ScrollView>
  );
}

export default function App() {
  const [paired, setPaired] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await getToken();
      if (!cancelled) setPaired(!!t);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        {paired === null ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator color={C.dim} />
          </View>
        ) : paired ? (
          <Campus
            onUnpair={async () => {
              await forgetDevice();
              setPaired(false);
            }}
          />
        ) : (
          <PairScreen onPaired={() => setPaired(true)} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

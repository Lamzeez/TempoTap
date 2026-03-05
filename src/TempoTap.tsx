import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
  Platform,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path, Circle, Line } from "react-native-svg";
import * as Haptics from "expo-haptics";
import { Audio } from "expo-av";
import AsyncStorage from "@react-native-async-storage/async-storage";

type Screen = "start" | "game" | "gameover";

const BEST_KEY = "tempo_tap_best_score";

const { width: SCREEN_W } = Dimensions.get("window");

const SFX = {
  hit: require("../assets/sfx/hit.mp3"),
  miss: require("../assets/sfx/miss.mp3"),
};

const UI = {
  white: "#FFFFFF",
  white90: "rgba(255,255,255,0.9)",
  white80: "rgba(255,255,255,0.8)",
  white70: "rgba(255,255,255,0.7)",
  white60: "rgba(255,255,255,0.6)",
  white30: "rgba(255,255,255,0.30)",
  white18: "rgba(255,255,255,0.18)",
  white12: "rgba(255,255,255,0.12)",
  pillTextPurple: "#7C3AED",
  glow: "rgba(255,255,255,0.35)",
  green: "#39D353",
  arc: "rgba(255,255,255,0.35)",
};

const TICK_MS = 16; // ~60fps
const BASE_SPEED_DEG = 1.6; // degrees per tick
const MAX_SPEED_DEG = 6.2;

// Arc geometry (semi-ish)
const ARC_START_DEG = 205; // left-ish
const ARC_END_DEG = 335; // right-ish
const ARC_SPAN = ARC_END_DEG - ARC_START_DEG;

function degToRad(d: number) {
  return (d * Math.PI) / 180;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const a = degToRad(angleDeg);
  return {
    x: cx + r * Math.cos(a),
    y: cy + r * Math.sin(a),
  };
}

// SVG arc path from angle A to B (clockwise)
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  // sweep-flag 1 means clockwise
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function TempoTap() {
  const [screen, setScreen] = useState<Screen>("start");

  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);

  // gameplay: moving dot angle + direction
  const angleRef = useRef(ARC_START_DEG);
  const dirRef = useRef<1 | -1>(1);
  const speedRef = useRef(BASE_SPEED_DEG);

  // safe zone center + width (degrees)
  const safeCenterRef = useRef(ARC_START_DEG + ARC_SPAN * 0.22);
  const safeWidthRef = useRef(26); // degrees; shrinks every 5 points

  // force re-render for SVG positions
  const [, forceTick] = useState(0);

  // one tap lock
  const tapLockedRef = useRef(false);

  // tap UI feedback
  const tapScale = useRef(new Animated.Value(1)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;

  // audio
  const hitSoundRef = useRef<Audio.Sound | null>(null);
  const missSoundRef = useRef<Audio.Sound | null>(null);

  const header = useMemo(() => {
    if (screen === "start") return "TEMPO\nTAP";
    if (screen === "game") return "Tempo Tap";
    return "GAME\nOVER";
  }, [screen]);

  // load audio
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });

        const hit = new Audio.Sound();
        const miss = new Audio.Sound();
        await hit.loadAsync(SFX.hit);
        await miss.loadAsync(SFX.miss);

        if (!mounted) {
          await hit.unloadAsync();
          await miss.unloadAsync();
          return;
        }

        hitSoundRef.current = hit;
        missSoundRef.current = miss;
      } catch {
        hitSoundRef.current = null;
        missSoundRef.current = null;
      }
    })();

    return () => {
      mounted = false;
      (async () => {
        try {
          await hitSoundRef.current?.unloadAsync();
          await missSoundRef.current?.unloadAsync();
        } catch {}
      })();
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(BEST_KEY);
        const n = raw ? Number(raw) : 0;
        if (mounted) setBest(Number.isFinite(n) ? n : 0);
      } catch {
        if (mounted) setBest(0);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const playHit = async () => {
    try {
      await hitSoundRef.current?.replayAsync();
    } catch {}
  };

  const playMiss = async () => {
    try {
      await missSoundRef.current?.replayAsync();
    } catch {}
  };

  // best update on gameover
  useEffect(() => {
    if (screen !== "gameover") return;

    (async () => {
      try {
        const nextBest = Math.max(best, score);
        if (nextBest !== best) {
          setBest(nextBest);
          await AsyncStorage.setItem(BEST_KEY, String(nextBest));
        }
      } catch {
        // ignore write failures
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, score]);

  // game loop
  useEffect(() => {
    if (screen !== "game") return;

    const id = setInterval(() => {
      const next = angleRef.current + dirRef.current * speedRef.current;

      if (next <= ARC_START_DEG) {
        angleRef.current = ARC_START_DEG;
        dirRef.current = 1;
      } else if (next >= ARC_END_DEG) {
        angleRef.current = ARC_END_DEG;
        dirRef.current = -1;
      } else {
        angleRef.current = next;
      }

      // allow tap again (prevents double-taps in same frame)
      tapLockedRef.current = false;

      // tick UI
      forceTick((x) => (x + 1) % 100000);
    }, TICK_MS);

    return () => clearInterval(id);
  }, [screen]);

  const pulseTap = () => {
    Animated.sequence([
      Animated.timing(tapScale, { toValue: 0.96, duration: 80, useNativeDriver: true }),
      Animated.timing(tapScale, { toValue: 1, duration: 140, useNativeDriver: true }),
    ]).start();
  };

  const glow = () => {
    glowOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(glowOpacity, { toValue: 1, duration: 80, useNativeDriver: true }),
      Animated.timing(glowOpacity, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]).start();
  };

  const randomizeSafeZone = () => {
    // avoid edges so it feels fair
    const pad = 10;
    const min = ARC_START_DEG + pad;
    const max = ARC_END_DEG - pad;
    safeCenterRef.current = min + Math.random() * (max - min);
  };

  const shrinkSafeZoneIfNeeded = (nextScore: number) => {
    if (nextScore > 0 && nextScore % 5 === 0) {
      safeWidthRef.current = Math.max(10, safeWidthRef.current - 4);
    }
  };

  const updateSpeed = (nextScore: number) => {
    // show as multiplier in UI; actual is deg/tick
    speedRef.current = clamp(BASE_SPEED_DEG + nextScore * 0.22, BASE_SPEED_DEG, MAX_SPEED_DEG);
  };

  const isHit = () => {
    const a = angleRef.current;
    const half = safeWidthRef.current / 2;
    const left = safeCenterRef.current - half;
    const right = safeCenterRef.current + half;
    return a >= left && a <= right;
  };

  const startGame = () => {
    setScore(0);
    angleRef.current = ARC_START_DEG;
    dirRef.current = 1;
    speedRef.current = BASE_SPEED_DEG;
    safeWidthRef.current = 26;
    randomizeSafeZone();
    tapLockedRef.current = false;
    setScreen("game");
  };

  const restart = () => startGame();

  const onTap = async () => {
    if (screen !== "game") return;
    if (tapLockedRef.current) return;

    tapLockedRef.current = true;
    pulseTap();
    glow();

    const hit = isHit();

    if (!hit) {
      try {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } catch {}
      await playMiss();
      setScreen("gameover");
      return;
    }

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
    await playHit();

    setScore((prev) => {
      const next = prev + 1;
      shrinkSafeZoneIfNeeded(next);
      updateSpeed(next);
      randomizeSafeZone();
      return next;
    });
  };

  // ---- SVG layout ----
  const arcSize = Math.min(SCREEN_W, 420);
  const svgW = arcSize;
  const svgH = arcSize * 0.62;
  const cx = svgW / 2;
  const cy = svgH * 0.95;
  const r = svgW * 0.33;

  const arcPath = describeArc(cx, cy, r, ARC_START_DEG, ARC_END_DEG);

  const safeHalf = safeWidthRef.current / 2;
  const safeStart = safeCenterRef.current - safeHalf;
  const safeEnd = safeCenterRef.current + safeHalf;
  const safePath = describeArc(cx, cy, r, safeStart, safeEnd);

  const dot = polarToCartesian(cx, cy, r, angleRef.current);
  const center = { x: cx, y: cy };
  const speedMultiplier = (speedRef.current / BASE_SPEED_DEG).toFixed(1);

  // =========================
  // Start Screen (like image)
  // =========================
  if (screen === "start") {
    return (
      <LinearGradient
        colors={["#6D28D9", "#D946EF", "#FB2C87"]}
        start={{ x: 0.05, y: 0.05 }}
        end={{ x: 0.95, y: 0.95 }}
        style={styles.full}
      >
        <View style={styles.safePad}>
          <Text style={styles.bigTitle}>{header}</Text>
          <Text style={styles.tagline}>1 Life. 1 Button.</Text>
          <Text style={styles.subText}>Tap when the line hits the zone!</Text>

          <View style={styles.bestCard}>
            <Text style={styles.cardLabel}>BEST SCORE</Text>
            <Text style={styles.cardValue}>{best}</Text>
          </View>

          <Pressable onPress={startGame} style={({ pressed }) => [styles.pillBtn, pressed && styles.pressed]}>
            <Text style={styles.pillBtnText}>START</Text>
          </Pressable>

          <Text style={styles.howToPlayTitle}>HOW TO PLAY</Text>
          <Text style={styles.howToPlayText}>
            Tap the button when the moving line enters the safe zone. Speed increases with each success!
          </Text>
        </View>
      </LinearGradient>
    );
  }

  // =========================
  // Game Over Screen (image)
  // =========================
  if (screen === "gameover") {
    return (
      <LinearGradient
        colors={["#FB2C87", "#A855F7", "#6D28D9"]}
        start={{ x: 0.15, y: 0.05 }}
        end={{ x: 0.9, y: 0.95 }}
        style={styles.full}
      >
        <View style={styles.safePad}>
          <Text style={styles.bigTitle}>{header}</Text>

          <View style={[styles.scoreCard, { marginTop: 18 }]}>
            <Text style={styles.cardLabel}>FINAL SCORE</Text>
            <Text style={styles.cardValue}>{score}</Text>
          </View>

          <View style={[styles.scoreCard, { marginTop: 14, paddingVertical: 14 }]}>
            <Text style={styles.cardLabel}>BEST SCORE</Text>
            <Text style={[styles.cardValue, { fontSize: 28 }]}>{Math.max(best, score)}</Text>
          </View>

          <Pressable onPress={restart} style={({ pressed }) => [styles.pillBtn, { marginTop: 18 }, pressed && styles.pressed]}>
            <Text style={styles.pillBtnText}>RESTART</Text>
          </Pressable>

          <Pressable
            onPress={() => setScreen("start")}
            style={({ pressed }) => [styles.pillOutlineBtn, pressed && styles.pressedSoft]}
          >
            <Text style={styles.pillOutlineText}>BACK TO START</Text>
          </Pressable>
        </View>
      </LinearGradient>
    );
  }

  // =========================
  // Game Screen (middle image)
  // =========================
  return (
    <LinearGradient
      colors={["#6D28D9", "#2563EB", "#06B6D4"]}
      start={{ x: 0.05, y: 0.05 }}
      end={{ x: 0.95, y: 0.95 }}
      style={styles.full}
    >
      <View style={styles.safePad}>
        {/* HUD */}
        <View style={styles.hudRow}>
          <View style={styles.hudSpacer} />

          <View style={styles.scoreBox}>
            <Text style={styles.hudLabel}>SCORE</Text>
            <Text style={styles.hudValue}>{score}</Text>
          </View>

          <View style={styles.speedBox}>
            <Text style={styles.hudLabel}>SPEED</Text>
            <Text style={styles.speedValue}>{speedMultiplier}x</Text>
          </View>
        </View>

        {/* Arc area */}
        <View style={styles.arcWrap}>
          <Animated.View style={{ transform: [{ scale: tapScale }] }}>
            <View style={styles.arcGlowWrap}>
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.arcGlow,
                  { opacity: glowOpacity },
                ]}
              />
              <Svg width={svgW} height={svgH}>
                {/* base arc */}
                <Path
                  d={arcPath}
                  stroke={UI.arc}
                  strokeWidth={6}
                  fill="none"
                  strokeLinecap="round"
                />

                {/* safe zone segment */}
                <Path
                  d={safePath}
                  stroke={UI.green}
                  strokeWidth={7}
                  fill="none"
                  strokeLinecap="round"
                />

                {/* pointer line */}
                <Line
                  x1={center.x}
                  y1={center.y}
                  x2={dot.x}
                  y2={dot.y}
                  stroke={UI.white}
                  strokeWidth={4}
                  strokeLinecap="round"
                />

                {/* moving dot */}
                <Circle cx={dot.x} cy={dot.y} r={9} fill={UI.white} />
              </Svg>
            </View>
          </Animated.View>
        </View>

        {/* Big TAP button */}
        <Pressable onPress={onTap} style={({ pressed }) => [styles.tapBtn, pressed && styles.tapPressed]}>
          <Text style={styles.tapText}>TAP</Text>
        </Pressable>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  full: {
    flex: 1,
  },
  safePad: {
    flex: 1,
    paddingTop: Platform.OS === "android" ? 38 : 22,
    paddingHorizontal: 22,
    paddingBottom: 24,
    alignItems: "center",
  },

  // Start/GameOver titles
  bigTitle: {
    color: UI.white,
    fontSize: 56,
    fontWeight: "900",
    letterSpacing: 1,
    textAlign: "center",
    lineHeight: 58,
    marginTop: 6,
  },
  tagline: {
    marginTop: 16,
    color: UI.white90,
    fontSize: 16,
    fontWeight: "700",
  },
  subText: {
    marginTop: 10,
    color: UI.white70,
    fontSize: 12,
    fontWeight: "600",
  },

  // Best/Score cards
  bestCard: {
    marginTop: 26,
    width: 150,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  scoreCard: {
    width: 170,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  cardLabel: {
    color: UI.white70,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  cardValue: {
    marginTop: 8,
    color: UI.white,
    fontSize: 44,
    fontWeight: "900",
  },

  // Pill buttons
  pillBtn: {
    marginTop: 28,
    width: "86%",
    height: 58,
    borderRadius: 999,
    backgroundColor: UI.white,
    alignItems: "center",
    justifyContent: "center",
  },
  pillBtnText: {
    color: UI.pillTextPurple,
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 1,
  },
  pillOutlineBtn: {
    marginTop: 14,
    width: "86%",
    height: 56,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  pillOutlineText: {
    color: UI.white,
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 0.9,
  },
  pressed: { transform: [{ scale: 0.98 }], opacity: 0.95 },
  pressedSoft: { transform: [{ scale: 0.99 }], opacity: 0.92 },

  // How to play
  howToPlayTitle: {
    marginTop: 34,
    color: UI.white60,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  howToPlayText: {
    marginTop: 8,
    color: UI.white70,
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
    paddingHorizontal: 22,
  },

  // Game HUD
  hudRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginTop: 8,
  },
  hudSpacer: { width: 78 },
  scoreBox: {
    width: 116,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  speedBox: {
    width: 86,
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  hudLabel: {
    color: UI.white70,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.1,
  },
  hudValue: {
    marginTop: 6,
    color: UI.white,
    fontSize: 30,
    fontWeight: "900",
  },
  speedValue: {
    marginTop: 4,
    color: UI.white,
    fontSize: 18,
    fontWeight: "900",
  },

  // Arc
  arcWrap: {
    flex: 1,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  arcGlowWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  arcGlow: {
    position: "absolute",
    width: SCREEN_W * 0.62,
    height: SCREEN_W * 0.62,
    borderRadius: 999,
    backgroundColor: UI.glow,
    opacity: 0,
    transform: [{ scale: 0.9 }],
  },

  // Big Tap Button
  tapBtn: {
    width: 130,
    height: 130,
    borderRadius: 999,
    backgroundColor: UI.white,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  tapPressed: { transform: [{ scale: 0.98 }], opacity: 0.95 },
  tapText: {
    color: UI.pillTextPurple,
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
});
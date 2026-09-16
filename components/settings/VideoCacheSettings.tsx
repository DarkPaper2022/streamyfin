import { Ionicons } from "@expo/vector-icons";
import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { PlatformDropdown } from "@/components/PlatformDropdown";
import { useSettings } from "@/utils/atoms/settings";
import { Text } from "../common/Text";
import { ListGroup } from "../list/ListGroup";
import { ListItem } from "../list/ListItem";

// Options offered for the look-ahead count and the cache size budget.
// Exported so the TV settings screen renders the same lists.
export const VIDEO_LOOKAHEAD_COUNT_OPTIONS = [
  { label: "1 episode", value: 1 },
  { label: "2 episodes", value: 2 },
  { label: "3 episodes", value: 3 },
] as const;

export const VIDEO_CACHE_SIZE_OPTIONS = [
  { label: "256 MB", value: 256 },
  { label: "512 MB", value: 512 },
  { label: "1 GB", value: 1024 },
  { label: "2 GB", value: 2048 },
  { label: "4 GB", value: 4096 },
] as const;

export const VideoCacheSettings: React.FC = () => {
  const { settings, updateSettings, pluginSettings } = useSettings();
  const { t } = useTranslation();

  const lookaheadCountOptions = useMemo(
    () => [
      {
        options: VIDEO_LOOKAHEAD_COUNT_OPTIONS.map((option) => ({
          type: "radio" as const,
          label: option.label,
          value: String(option.value),
          selected: option.value === settings?.videoLookaheadCount,
          onPress: () => updateSettings({ videoLookaheadCount: option.value }),
        })),
      },
    ],
    [settings?.videoLookaheadCount, updateSettings],
  );

  const cacheSizeOptions = useMemo(
    () => [
      {
        options: VIDEO_CACHE_SIZE_OPTIONS.map((option) => ({
          type: "radio" as const,
          label: option.label,
          value: String(option.value),
          selected: option.value === settings?.videoMaxCacheSizeMB,
          onPress: () => updateSettings({ videoMaxCacheSizeMB: option.value }),
        })),
      },
    ],
    [settings?.videoMaxCacheSizeMB, updateSettings],
  );

  const currentLookaheadLabel =
    VIDEO_LOOKAHEAD_COUNT_OPTIONS.find(
      (option) => option.value === settings?.videoLookaheadCount,
    )?.label ?? `${settings?.videoLookaheadCount} episodes`;

  const currentCacheSizeLabel =
    VIDEO_CACHE_SIZE_OPTIONS.find(
      (option) => option.value === settings?.videoMaxCacheSizeMB,
    )?.label ?? `${settings?.videoMaxCacheSizeMB} MB`;

  if (!settings) return null;

  return (
    <ListGroup
      title={t("home.settings.video_cache.caching_title")}
      description={
        <Text className='text-[#8E8D91] text-xs'>
          {t("home.settings.video_cache.caching_description")}
        </Text>
      }
      className='mb-4'
    >
      <ListItem
        title={t("home.settings.video_cache.lookahead_enabled")}
        disabled={pluginSettings?.videoLookaheadEnabled?.locked}
      >
        <SettingSwitch
          value={settings.videoLookaheadEnabled}
          disabled={pluginSettings?.videoLookaheadEnabled?.locked}
          onValueChange={(videoLookaheadEnabled) =>
            updateSettings({ videoLookaheadEnabled })
          }
        />
      </ListItem>

      <ListItem
        title={t("home.settings.video_cache.lookahead_count")}
        disabled={
          pluginSettings?.videoLookaheadCount?.locked ||
          !settings.videoLookaheadEnabled
        }
      >
        <PlatformDropdown
          groups={lookaheadCountOptions}
          trigger={
            <View className='flex flex-row items-center justify-between py-1.5 pl-3'>
              <Text className='mr-1 text-[#8E8D91]'>
                {currentLookaheadLabel}
              </Text>
              <Ionicons name='chevron-expand-sharp' size={18} color='#5A5960' />
            </View>
          }
          title={t("home.settings.video_cache.lookahead_count")}
        />
      </ListItem>

      <ListItem
        title={t("home.settings.video_cache.max_cache_size")}
        disabled={pluginSettings?.videoMaxCacheSizeMB?.locked}
      >
        <PlatformDropdown
          groups={cacheSizeOptions}
          trigger={
            <View className='flex flex-row items-center justify-between py-1.5 pl-3'>
              <Text className='mr-1 text-[#8E8D91]'>
                {currentCacheSizeLabel}
              </Text>
              <Ionicons name='chevron-expand-sharp' size={18} color='#5A5960' />
            </View>
          }
          title={t("home.settings.video_cache.max_cache_size")}
        />
      </ListItem>
    </ListGroup>
  );
};

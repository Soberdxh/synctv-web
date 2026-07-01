import { debounces } from "@/utils";
import { useDebounceFn } from "@vueuse/core";
import { type WatchStopHandle } from "vue";
import { Message, MessageType, Status } from "@/proto/message";
import Artplayer from "artplayer";
import { ElNotification } from "element-plus";

const artPlay = async (art: Artplayer) => {
  let retry = false;
  await art.video.play().catch(() => {
    art.muted = true;
    retry = true;
  });
  if (retry)
    await art.video
      .play()
      .then(() => {
        ElNotification({
          title: "温馨提示",
          type: "info",
          message: "由于浏览器限制，播放器已静音，请手动开启声音"
        });
      })
      .catch((e) => {
        ElNotification({
          title: "自动播放失败，请手动点击同步按钮",
          type: "error",
          message: e
        });
      });
};

interface syncPlugin {
  name: string;
  setAndNoPublishSeek: (seek: number) => void;
  setAndNoPublishPlay: () => void;
  setAndNoPublishPause: () => void;
  setAndNoPublishRate: (rate: number) => void;
  setAndNoPublishStatus: (status: Status) => void;
  currentStatus: () => Status;
}

const debounceTime = 500;

const newSyncControl = (art: Artplayer, publishStatus: (msg: Message) => boolean) => {
  const syncControl = () => {
    publishStatus(
      Message.create({
        type: MessageType.SYNC
      })
    );
  };

  art.controls.add({
    name: "syncPlugin",
    html: "同步",
    position: "right",
    click: syncControl
  });

  art.setting.add({
    name: "syncPlugin",
    html: "同步状态",
    selector: [
      {
        default: true,
        html: "点击同步"
      }
    ],
    onSelect: syncControl
  });
};

export const newSyncPlugin = (
  publishStatus: (msg: Message) => boolean,
  initStatus: Status,
  dynamicCurrentExpireId: () => number,
  canControl: boolean = true
) => {
  return (art: Artplayer): syncPlugin => {
    const playingStatusDebounce = debounces(debounceTime);

    // 修复5: 区分用户主动 seek 和同步 seek,仅用户主动 seek 触发 checkStatus 冷却
    let lastUserSeek = 0;
    let lastSyncSeek = 0;

    // 修复3: 同步触发的事件抑制窗口(100ms),防止 setAndNoPublish* 触发的 art 事件重新广播
    let suppressPublishUntil = 0;
    const setSuppress = () => {
      suppressPublishUntil = Date.now() + 100;
    };

    // 修复4: 缓冲统一等待标记。缓冲期间常规 play/pause/seek 广播被抑制,仅 waiting/canplay 可广播
    let isBuffering = false;

    // 修复0: 无权限用户首次操作通知标记,避免通知风暴
    let hasNotifiedNoPermission = false;
    const notifyNoPermission = () => {
      if (!hasNotifiedNoPermission) {
        hasNotifiedNoPermission = true;
        ElNotification({
          title: "无权控制",
          type: "info",
          message: "您无权控制播放,已同步到房主进度"
        });
      }
    };

    const publishSeek = () => {
      // 修复4: 缓冲期间不广播常规 seek
      if (isBuffering) return;
      // 修复0: 无权限不广播 STATUS
      if (!canControl) return;
      // 修复3: 同步触发的事件抑制
      if (Date.now() < suppressPublishUntil) return;
      console.groupCollapsed("广播视频空降");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: !art.video.paused,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    const __publishSeekDebounce = useDebounceFn(publishSeek, debounceTime);

    const publishSeekDebounce = function () {
      // 修复5: 用户主动 seek 更新 lastUserSeek(触发 checkStatus 冷却)
      lastUserSeek = Date.now();
      __publishSeekDebounce();
    };

    const setAndNoPublishSeek = (seek: number) => {
      // 修复5: 同步 seek 更新 lastSyncSeek(不触发 checkStatus 冷却)
      lastSyncSeek = Date.now();
      if (art.option.isLive || Math.abs(art.currentTime - seek) < 2) return;
      console.groupCollapsed("设置seek(非广播)");
      console.log("seek:", seek);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      // 修复3: 设置抑制窗口,防止 seek 触发的事件重新广播
      setSuppress();
      art.currentTime = seek;
    };

    const publishPlay = () => {
      if (isBuffering) return;
      if (!canControl) return;
      if (Date.now() < suppressPublishUntil) return;
      console.groupCollapsed("广播视频播放");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: true,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    const publishPlayDebounce = playingStatusDebounce(publishPlay);

    const setAndNoPublishPlay = async () => {
      if (!art.video.paused) return;
      console.groupCollapsed("设置播放(非广播)");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      // 修复3: 设置抑制窗口
      setSuppress();
      await artPlay(art);
    };

    const publishPause = () => {
      if (isBuffering) return;
      if (!canControl) return;
      if (Date.now() < suppressPublishUntil) return;
      console.groupCollapsed("广播视频暂停");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: false,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    const publishPauseDebounce = playingStatusDebounce(publishPause);

    const setAndNoPublishPause = () => {
      if (art.video.paused) return;
      console.groupCollapsed("设置暂停(非广播)");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      // 修复3: 设置抑制窗口
      setSuppress();
      art.video.pause();
    };

    const publishRate = () => {
      if (isBuffering) return;
      if (!canControl) return;
      if (Date.now() < suppressPublishUntil) return;
      console.groupCollapsed("广播视频倍速");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: !art.video.paused,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    const setAndNoPublishRate = (rate: number) => {
      if (art.option.isLive || art.playbackRate === rate) return;
      console.groupCollapsed("设置倍速(非广播)");
      console.log("rate:", rate);
      console.groupEnd();
      // 修复3: 设置抑制窗口,移除原来复杂的 off/once/on 逻辑,统一用窗口抑制
      setSuppress();
      art.playbackRate = rate;
    };

    // 修复4: 缓冲统一等待 - 缓冲时广播暂停给全员
    const publishBufferPause = () => {
      if (!canControl) {
        // 无权限用户缓冲:发 SYNC 拉回服务器位置(服务器会返回正确位置)
        publishStatus(Message.create({ type: MessageType.SYNC }));
        return;
      }
      console.groupCollapsed("广播缓冲暂停");
      console.log("seek:", art.currentTime);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: false,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    // 修复4: 缓冲统一等待 - 恢复时广播继续给全员
    const publishBufferPlay = () => {
      if (!canControl) {
        publishStatus(Message.create({ type: MessageType.SYNC }));
        return;
      }
      console.groupCollapsed("广播缓冲恢复");
      console.log("seek:", art.currentTime);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: true,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    const __publishBufferPauseDebounce = useDebounceFn(publishBufferPause, debounceTime);
    const __publishBufferPlayDebounce = useDebounceFn(publishBufferPlay, debounceTime);

    const checkStatus = () => {
      // 修复4: 缓冲期间跳过自检
      if (isBuffering) return;
      // 修复5: 仅用户主动 seek 触发冷却(同步 seek 用 lastSyncSeek,不影响冷却)
      if (
        Date.now() - lastUserSeek < 10000 ||
        art.option.isLive ||
        art.duration - art.currentTime < 5
      ) {
        return;
      }
      console.groupCollapsed("检查状态");
      console.log("seek:", art.currentTime);
      console.log("rate:", art.playbackRate);
      console.log("playing:", !art.video.paused);
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.CHECK_STATUS,
          timestamp: Date.now(),
          playbackStatus: {
            isPlaying: !art.video.paused,
            currentTime: art.currentTime,
            playbackRate: art.playbackRate
          }
        })
      );
    };

    const checkExpire = () => {
      console.groupCollapsed("检查过期");
      console.log("expireId:", dynamicCurrentExpireId());
      console.groupEnd();
      publishStatus(
        Message.create({
          type: MessageType.EXPIRED,
          timestamp: Date.now(),
          expirationId: dynamicCurrentExpireId()
        })
      );
    };

    const setAndNoPublishStatus = async (status: Status) => {
      console.groupCollapsed("设置状态(非广播)");
      console.log("seek:", status.currentTime);
      console.log("rate:", status.playbackRate);
      console.log("playing:", status.isPlaying);
      console.groupEnd();
      if (!art.option.isLive) {
        setAndNoPublishRate(status.playbackRate);
        setAndNoPublishSeek(status.currentTime);
      }
      status.isPlaying ? await setAndNoPublishPlay() : setAndNoPublishPause();
    };

    const currentStatus = (): Status => {
      return {
        isPlaying: !art.video.paused,
        currentTime: art.currentTime,
        playbackRate: art.playbackRate
      };
    };

    // 修复0: 事件处理器。无权限用户操作后立即发 SYNC 拉回,而非等 10 秒 CHECK_STATUS
    // 修复3: 程序触发的事件(setAndNoPublish* 设置的)在抑制窗口内,直接返回
    const onPlay = () => {
      if (Date.now() < suppressPublishUntil) return;
      if (!canControl) {
        notifyNoPermission();
        publishStatus(Message.create({ type: MessageType.SYNC }));
        return;
      }
      publishPlayDebounce();
    };

    const onPause = () => {
      if (Date.now() < suppressPublishUntil) return;
      if (!canControl) {
        notifyNoPermission();
        publishStatus(Message.create({ type: MessageType.SYNC }));
        return;
      }
      publishPauseDebounce();
    };

    const onSeek = () => {
      if (Date.now() < suppressPublishUntil) return;
      if (!canControl) {
        notifyNoPermission();
        publishStatus(Message.create({ type: MessageType.SYNC }));
        return;
      }
      publishSeekDebounce();
    };

    const onRateChange = () => {
      if (Date.now() < suppressPublishUntil) return;
      if (!canControl) {
        notifyNoPermission();
        publishStatus(Message.create({ type: MessageType.SYNC }));
        return;
      }
      publishRate();
    };

    // 修复4: 缓冲统一等待事件处理器
    const onWaiting = () => {
      isBuffering = true;
      __publishBufferPauseDebounce();
    };

    const onCanplay = () => {
      // 非缓冲态的 canplay 忽略(如首次加载)
      if (!isBuffering) return;
      isBuffering = false;
      __publishBufferPlayDebounce();
    };

    const intervals: number[] = [];
    const watchers: WatchStopHandle[] = [];
    art.on("destroy", () => {
      intervals.forEach((interval) => {
        clearInterval(interval);
      });
      watchers.forEach((watcher) => {
        watcher();
      });
    });

    if (!art.option.isLive) {
      art.once("ready", async () => {
        console.groupCollapsed("同步状态");
        console.log("seek:", initStatus.currentTime);
        console.log("rate:", initStatus.playbackRate);
        console.log("playing:", initStatus.isPlaying);
        console.groupEnd();
        art.currentTime = initStatus.currentTime;
        art.playbackRate = initStatus.playbackRate;
        if (initStatus.isPlaying) {
          await artPlay(art);
        }

        intervals.push(setInterval(checkStatus, 10000));
        intervals.push(setInterval(checkExpire, 10000));

        newSyncControl(art, publishStatus);

        art.on("play", onPlay);

        // 视频暂停
        art.on("pause", onPause);

        // 空降
        art.on("seek", onSeek);

        // 倍速
        art.on("video:ratechange", onRateChange);

        // 修复4: 缓冲统一等待
        art.on("waiting", onWaiting);
        art.on("canplay", onCanplay);

        art.on("destroy", () => {
          art.off("play", onPlay);
          art.off("pause", onPause);
          art.off("seek", onSeek);
          art.off("video:ratechange", onRateChange);
          art.off("waiting", onWaiting);
          art.off("canplay", onCanplay);
        });
      });
    } else {
      art.once("ready", () => {
        setAndNoPublishPlay();
        intervals.push(setInterval(checkExpire, 10000));
      });
    }

    return {
      name: "syncPlugin",
      setAndNoPublishSeek,
      setAndNoPublishPlay,
      setAndNoPublishPause,
      setAndNoPublishRate,
      setAndNoPublishStatus,
      currentStatus
    };
  };
};

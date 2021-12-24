import { spawn } from 'child_process';
import fs from 'fs';
import { join, extname, basename } from 'path';
import { tmpdir } from 'os';

import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import Tidbyt from 'tidbyt';
import scheduler from 'node-schedule';
import Bottleneck from 'bottleneck';

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { TidbytDeviceHandler } from './tidbyt-device';

const CACHE_DIR = join(tmpdir(), PLUGIN_NAME, 'cache');
const updateLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1500,
});

/**
 * TidbytPlatform
 * This class is the main constructor for the plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class TidbytPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly handlers: Map<string, TidbytDeviceHandler> = new Map<string, TidbytDeviceHandler>();
  
  public readonly tidbyt: Tidbyt;
  private updating = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    process.on('uncaughtException', (err) => {
      this.log.error(err.stack || err.message);
    });

    // We can't start without being configured.
    if (!config) {
      return;
    }

    const { authToken } = config;

    if (!authToken) {
      this.log.warn(`No auth token configured. For configuration instructions, visit https://github.com/drudge/${PLUGIN_NAME}.`);
      return;
    }

    this.tidbyt = new Tidbyt(authToken);

    this.log.debug('Finished initializing platform:', PLATFORM_NAME);
    this.api.on('didFinishLaunching', this.init.bind(this));
  }

  async init() {
    const { discoverFrequency = 60000 } = this.config;

    this.log.debug('Update Frequency: %i ms', discoverFrequency);

    // Refresh devices
    await this.updateDevices();

    // Make sure cache directory exists
    await this.setupCache();
    // Load custom apps from config and schedule/start them
    await this.handleCustomApps();

    // Schedule future updates
    setInterval(async () => this.updateDevices(), discoverFrequency);
  }

  
  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  async setupCache() {
    try {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
      if (error.code === 'EEXIST') {
        const lstat = await fs.promises.lstat(CACHE_DIR);
        if (!lstat.isDirectory()) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  async handleCustomApps() {
    const managedDevices = this.config.managedDevices || [];

    for (const managedDevice of managedDevices) {
      const device = await this.tidbyt.devices.get(managedDevice.id);
      const customApps = this.config.customApps || [];

      for (const customApp of customApps) {
        const {
          id,
          enabled = false,
          script,
          config = [],
          schedule,
          updateOnStartup = true,
          fetch = async () => {
            return config;
          },
        } = customApp;
        const label = id || '-transient-';

        this.log.info(`[${label}] Initializing app${!id ? `: ${script}` : ''}`);

        if (!enabled) {
          this.log.debug(`[${label}] is disabled, attempting to remove any active installations`);
          await updateLimiter.schedule(async () => {
            try {
              await device.installations.delete(id);
            } catch (e) {
              if (!e.message.includes('installation not found')) {
                this.log.error(`Failed to remove installation ${id}: ${e.message}`);
              }
            }
          });
          continue;
        }

        let first = true;
        const invoke = async () => {
          if (!first) {
            this.log.info(`[${label}] Refreshing app`);
          }
          first = false;
          this.log.debug(`[${label}] Fetching...`);
          let image;
          try {
            customApp.config = await fetch(config);
            this.log.info(`[${label}] Rendering: ${script} ${customApp.config.map(({key, value}) => `${key}=${value}`).join(' ')}`);
            image = await this.renderPixlet(script, customApp.config);
          } catch (e) {
            this.log.error(`[${label}] Failed to render: ${e.message}`);
          }

          if (image) {
            this.log.info(`[${label}] Pushing to device`);
            try {
              await device.push(image, id);
            } catch (error) {
              this.log.error(`[${label}] Failed to push ${id}: ${error.message}`);
            }
          }
        };

        // schedule using a cron expression if we have one
        if (schedule) {
          this.log.info(`[${label}] Schedule: ${schedule}`);
          scheduler.scheduleJob(schedule, invoke);
        }

        // invoke immediately
        if (updateOnStartup) {
          await invoke();
        }
      }
    }
  }

  async renderPixlet(fileName, context = []) {
    const extName = extname(fileName);
    const baseFilename = basename(fileName, extName);
    const renderedFileName = join(CACHE_DIR, `${baseFilename}.webp`);

    return new Promise((resolve, reject) => {
      const keyValuePairs = context.map(({ key, value }) => `${key}=${value || ''}`);
      const pixlet = spawn('pixlet', [
        'render',
        fileName,
        ...keyValuePairs,
        '-o',
        renderedFileName,
      ]);
      
      pixlet.stdout.on('data', data => this.log.info(data.toString('utf8')));
      pixlet.stderr.on('data', data => this.log.error(data.toString('utf8')));
      pixlet.on('close', async code => {
        if (code !== 0) {
          return reject(new Error(`pixlet exited with code ${code}`));
        }
        const renderedFile = await fs.promises.readFile(renderedFileName);
        resolve(renderedFile);
      });
    });
  }

  /**
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async updateDevices() {
    if (this.updating) {
      this.log.warn('Update already in progress. Skipping.');
      return;
    }

    this.updating = true;

    const managedDevices = this.config.managedDevices || [];

    for (const { id } of managedDevices) {
      const uuid = this.api.hap.uuid.generate(id);

      this.log.debug('UUID: %s - Device: %j', uuid, id);

      try {
        const tidbytDevice = await this.tidbyt.devices.get(id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        let accessory = existingAccessory;
        let handler = this.handlers.get(uuid);

        if (!accessory) {
          accessory = new this.api.platformAccessory(tidbytDevice.displayName, uuid);
        }
        
        if (!handler) {
          handler = new TidbytDeviceHandler(this, accessory);
        }

        handler.updateFromTidbytDevice(tidbytDevice);

        this.handlers.set(uuid, handler);

        if (existingAccessory) {
          this.log.debug('Updating ', tidbytDevice.displayName);
          this.api.updatePlatformAccessories([existingAccessory]);
        } else {
          this.log.info('Adding ', tidbytDevice.displayName);
          this.accessories.push(accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } catch (e) { 
        this.log.error(`Failed to update ${id}: ${e.stack}`);
      }
    }

    this.updating = false;
  }

}

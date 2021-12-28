
import {
  Characteristic,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';
import Bottleneck from 'bottleneck';

import once from 'once';
import { TidbytPlatform } from './tidbyt-platform';
import { DEFAULT_MANUFACTURER_NAME } from './settings';

export class TidbytDeviceHandler {
  public readonly Service: typeof Service = this.platform.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.platform.api.hap.Characteristic;

  private bulb: Service;
  private info: Service;

  private readonly log: Logger;

  private readonly tidbytAPILimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 1500,
  });

  constructor(
    private readonly platform: TidbytPlatform,
    private readonly platformAccessory: PlatformAccessory,
  ) {
    this.log = this.platform.log;

    this.bulb = this.getService(this.Service.Lightbulb);
    this.info = this.getService(this.Service.AccessoryInformation);

    //   this.bulb.getCharacteristic(this.Characteristic.On)
    //     .on('get', (fn) => this.isOn(fn))
    //     .on('set', (value, fn) => this.setOn(value, fn));

    this.bulb.getCharacteristic(this.Characteristic.Brightness)
      .on('get', (fn) => this.getBrightness(fn))
      .on('set', (value, fn) => this.setBrightness(value, fn));
  }

  isOn(callback) {
    const tidbytDevice = this.platformAccessory.context;
    let isOn = false;

    if (tidbytDevice) {
      isOn = tidbytDevice.brightness > 1;
    }

    callback(null, isOn);
  }

  setOn(value, callback) {
    const done = once(callback);
    const tidbytDevice = this.platformAccessory.context;
    const onBrightness = tidbytDevice.brightness > 1 ? tidbytDevice.brightness : 20;

    this.log.info(`Setting status of ${tidbytDevice.displayName} to ${value ? 'on' : 'off'}`);

    done(null, value);

    return this.tidbytAPILimiter.schedule(() => tidbytDevice.update({ brightness: value ? onBrightness : 1 })).then(device => {
      this.updateFromTidbytDevice(device);
    }).catch(err => {
      this.log.error(`Could not update status: ${err.stack || err.message}`);
    });
  }

  getBrightness(callback) {
    const deviceDetails = this.platformAccessory.context;
    callback(null, deviceDetails.brightness);
  }

  setBrightness(value, callback) {
    const done = once(callback);
    const tidbytDevice = this.platformAccessory.context;

    if (value >= 1 && value <= 100) {
      this.log.info(`Setting brightness of ${tidbytDevice.displayName} to ${value}`);
      done(null, value);
      return this.tidbytAPILimiter.schedule(() => tidbytDevice.update({ brightness: value })).then(device => {
        this.updateFromTidbytDevice(device);
      }).catch(err => {
        this.log.error(`Could not update brightness: ${err.stack || err.message}`);
      });
    } else {
      done(new Error('Invalid brightness value'));
    }
  }

  /**
   * Returns the service if it exists, otherwise create a service.
   */
  getService(service): Service {
    return this.platformAccessory.getService(service) || this.platformAccessory.addService(service);
  }

  updateFromTidbytDevice(tidbytDevice) {
    this.platformAccessory.context = tidbytDevice;

    this.log.debug('Updating ', tidbytDevice.displayName);

    const {
      displayName,
      brightness,
    } = tidbytDevice;

    try {
      this.bulb.getCharacteristic(this.Characteristic.Name).updateValue(displayName);
      this.bulb.getCharacteristic(this.Characteristic.Brightness).updateValue(brightness);

      this.info.getCharacteristic(this.Characteristic.Manufacturer).updateValue(DEFAULT_MANUFACTURER_NAME);
      this.info.getCharacteristic(this.Characteristic.Model).updateValue('v6');
      this.info.getCharacteristic(this.Characteristic.SerialNumber).updateValue('N/A');
      // this.infoService.getCharacteristic(this.Characteristic.FirmwareRevision).updateValue(this.status.FirmwareVersion);

    } catch (err) {
      if (err instanceof Error) {
        this.log.error('Could not update status: %s', err.stack || err.message);
      }
    }
  }
}
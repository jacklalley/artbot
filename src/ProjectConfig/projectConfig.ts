import { Message } from 'discord.js'
import * as dotenv from 'dotenv'
dotenv.config()

const ARTBOT_IS_PROD =
  process.env.ARTBOT_IS_PROD &&
  process.env.ARTBOT_IS_PROD.toLowerCase() == 'true'
console.log('ARTBOT_IS_PROD: ', ARTBOT_IS_PROD)
// Refresh takes around one minute, so recommend setting this to 60 minutes
const METADATA_REFRESH_INTERVAL_MINUTES =
  process.env.METADATA_REFRESH_INTERVAL_MINUTES ?? '60'
const CHANNELS = ARTBOT_IS_PROD
  ? require('./channels.json')
  : require('./channels_dev.json')
const PROJECT_BOTS = ARTBOT_IS_PROD
  ? require('./projectBots.json')
  : require('./projectBots_dev.json')
import { ProjectBot } from '../Classes/ProjectBot'
const { getContractProject } = require('../Utils/parseArtBlocksAPI')
const PARTNER_CONTRACTS = require('../ProjectConfig/partnerContracts.json')

type ProjectBotHandlers = {
  default: string
  stringTriggers?: {
    [projectId: string]: string[]
  }
  tokenIdTriggers?: {
    [projectId: string]: number[]
  }[]
}

type ChannelsJson = {
  [chId: string]: {
    name: string
    projectBotHandlers?: ProjectBotHandlers
  }
}
type ProjectBotsJson = {
  [projectId: string]: {
    namedMappings: {
      sets?: string
      singles?: string
    }
  }
}

// utility class that routes number messages for each channel
class Channel {
  name: string
  hasProjectBotHandler: boolean
  default?: string
  stringTriggers?: { [key: string]: string[] }
  tokenIdTriggers?: { [key: string]: number[] }[]
  constructor(name: string, projectBotHandlers?: ProjectBotHandlers) {
    this.name = name
    this.hasProjectBotHandler = !!projectBotHandlers
    if (projectBotHandlers) {
      this.default = projectBotHandlers.default
      this.stringTriggers = projectBotHandlers.stringTriggers || undefined
      this.tokenIdTriggers = projectBotHandlers.tokenIdTriggers || undefined
    }
  }

  /*
   * This returns the appropriate project bot name to handle an incoming
   * number (^#) message, based on lowercase message content.
   * If any trigger words or trigger tokenID ranges are found, will
   * return name of appropriate non-default project bot.
   * If no trigger words or trigger tokenID ranges are found, will
   * return name of default project bot.
   * @return {string | null} name of project bot to handle message, null if
   * no project bot handlers defined for this Channel.
   */
  botNameFromNumberMsgContent(msgContentLowercase: string) {
    if (!this.hasProjectBotHandler) {
      return null
    }
    // determine which project bot to send msg
    let projectBotName = this.default
    // match with any string triggers
    if (this.stringTriggers) {
      Object.entries(this.stringTriggers).forEach(([botName, triggers]) => {
        triggers.forEach((trigger) => {
          if (msgContentLowercase.includes(trigger)) {
            projectBotName = botName
          }
        })
      })
    }
    // match with any tokenID trigger ranges
    if (this.tokenIdTriggers) {
      const tokenRegEx = msgContentLowercase.match(/\d+/)
      if (tokenRegEx) {
        const tokenID = parseInt(tokenRegEx[0])
        this.tokenIdTriggers.forEach((tokenIdTrigger) => {
          Object.entries(tokenIdTrigger).forEach(([botName, ranges]) => {
            if (tokenID >= ranges[0] && tokenID <= ranges[1]) {
              projectBotName = botName
            }
          })
        })
      }
    }
    // send to projectBot to handle the message
    return projectBotName
  }

  // this returns if val is in inclusive range [minVal, maxVal].
  // treats null minVal as -inf, maxVal as +inf
  static _inRange(val: number, minVal: number, maxVal: number) {
    return (
      (minVal === null || val >= minVal) && (maxVal === null || val <= maxVal)
    )
  }
}

/*
 * An instance of this class is exported to provide:
 *  - interface to lookup coreContracts by label (e.g. OG, V2)
 *  - interface to lookup channelIDs by name
 *  - interface to route incoming messages from identified project channels.
 */
class ProjectConfig {
  channels: { [key: string]: Channel }
  projectBots: { [key: string]: ProjectBot }
  chIdByName: { [key: string]: string }
  projectToChannel: { [key: string]: string }
  constructor() {
    this.channels = ProjectConfig.buildChannelHandlers(CHANNELS)
    this.chIdByName = ProjectConfig.buildChannelIDByName(this.channels)
    this.projectToChannel = {}
    this.projectBots = {}
    this.initialize()
  }

  // Initialize async aspects of the ProjectConfig
  async initialize() {
    try {
      this.projectBots = await this.buildProjectBots(CHANNELS, PROJECT_BOTS)
      setInterval(
        () => this.buildProjectBots(CHANNELS, PROJECT_BOTS),
        parseInt(METADATA_REFRESH_INTERVAL_MINUTES) * 60000
      )
    } catch (err) {
      console.error(`Error while initializing ProjectBots: ${err}`)
    }
  }

  /*
   * This parses imported projectBotsJson, channelsJson, and subgraph data to
   * return an object with keys equal to project ID and values pointing to a new
   * instance of ProjectBot. Returned object is useful for getting project bot
   * instances by project ID.
   */
  async buildProjectBots(
    channelsJson: ChannelsJson,
    projectBotsJson: ProjectBotsJson
  ): Promise<{ [key: string]: ProjectBot }> {
    const projectBots: { [key: string]: ProjectBot } = {}

    // Loops over channelsJson and adds all project IDs to a set of bots that
    // need to be instatiated.
    const botsToInstatiate = new Set<string>()
    Object.keys(channelsJson).forEach((channel) => {
      const projectBotHandlers = channelsJson[channel].projectBotHandlers
      if (!projectBotHandlers) {
        return
      }
      botsToInstatiate.add(projectBotHandlers.default)
      this.projectToChannel[projectBotHandlers.default] = channel

      const { stringTriggers = {}, tokenIdTriggers = [] } = projectBotHandlers
      Object.keys(stringTriggers).forEach((key) => {
        botsToInstatiate.add(key)
        this.projectToChannel[key] = channel
      })

      tokenIdTriggers.forEach((tokenTrigger) => {
        Object.keys(tokenTrigger).forEach((key) => {
          botsToInstatiate.add(key)
          this.projectToChannel[key] = channel
        })
      })
    })

    // This loops through all bots that need to be instatiated asynchronously,
    // gets the relevant configuration from projectBotsJson, calls the subgraph
    // to get project information, and then initializes the project bot.
    const promises = Array.from(botsToInstatiate).map(async (botId: string) => {
      const [projectId, contractName] = botId.split('-')
      const namedMappings = projectBotsJson[botId]?.namedMappings
      const configContract = PARTNER_CONTRACTS[contractName]
      if (contractName && !configContract) {
        console.warn(
          `Bot ${botId} had a contractName, but there was no matching contract in partnerContracts.json. Has it been defined?`
        )
      }
      const projectNumber = parseInt(projectId)
      const { invocations, name, active, contract } = await getContractProject(
        projectNumber,
        configContract
      )
      console.log(
        `Refreshing project cache for Project ${projectNumber} ${name}`
      )
      projectBots[botId] = new ProjectBot(
        projectNumber,
        contract.id,
        invocations,
        name,
        active,
        namedMappings
      )
    })

    await Promise.all(promises)
    return projectBots
  }

  /*
   * This parses imported channels json data and returns an object with
   * keys equal to channel name, values pointing to a new instance of Channel.
   * Returned object is useful for getting channel instances by channel ID.
   */
  static buildChannelHandlers(ChannelsJson: ChannelsJson): {
    [key: string]: Channel
  } {
    const channels: { [key: string]: Channel } = {}
    Object.entries(ChannelsJson).forEach(([chID, chParams]) => {
      channels[chID] = new Channel(chParams.name, chParams.projectBotHandlers)
    })
    return channels
  }

  /*
   * This parses imported channels json data and returns an object with
   * keys equal to channel name, values equal to channel ID.
   * Returned object is useful for getting channel ID by channel name.
   */
  static buildChannelIDByName(channels: { [key: string]: Channel }): {
    [key: string]: string
  } {
    const chIdByName: { [key: string]: string } = {}
    Object.entries(channels).forEach(([chID, channel]) => {
      chIdByName[channel.name] = chID
    })
    return chIdByName
  }

  /*
   * This routes an incoming number (^#) message intended to be routed to a
   * projectBot. It utilizes the logic in Channel method
   * botNameFromNumberMsgContent to determine which project bot should
   * handle the message (trigger words, token ID ranges, etc.).
   * @param {string} channelID Channel ID the incoming msg has been sent from.
   * @param msg Incoming discord.js message object
   */
  routeProjectNumberMsg(channelID: string, msg: Message) {
    const channel = this.channels[channelID]
    const botName = channel.botNameFromNumberMsgContent(
      msg.content.toLowerCase()
    )
    if (!botName) {
      // only occurs when # messages are sent in observed channels without project bots
      console.error(`Channel ID: ${channelID} does not have a ProjectBot`)
      return
    }
    this.projectBots[botName].handleNumberMessage(msg)
  }
}

const projectConfig = new ProjectConfig()
module.exports.projectConfig = projectConfig

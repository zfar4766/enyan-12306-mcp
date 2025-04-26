#!/usr/bin/env node

// Data一般用于表示从服务器上请求到的数据，Info一般表示解析并筛选过的要传输给大模型的数据。变量使用驼峰命名，常量使用全大写下划线命名。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { z } from 'zod';
import {
  Price,
  RouteStationData,
  RouteStationInfo,
  StationData,
  StationDataKeys,
  TicketData,
  TicketDataKeys,
  TicketInfo,
} from './types.js';

const API_BASE = 'https://kyfw.12306.cn';
const WEB_URL = 'https://www.12306.cn/index/';
const STATIONS: Record<string, StationData> = await getStations(); //以Code为键
const CITY_STATIONS: Record<
  string,
  { station_code: string; station_name: string }[]
> = (() => {
  const result: Record<
    string,
    { station_code: string; station_name: string }[]
  > = {};
  for (const station of Object.values(STATIONS)) {
    const city = station.city;
    if (!result[city]) {
      result[city] = [];
    }
    result[city].push({
      station_code: station.station_code,
      station_name: station.station_name,
    });
  }
  return result;
})(); //以城市名名为键，位于该城市的的所有Station列表的记录

const CITY_CODES: Record<
  string,
  { station_code: string; station_name: string }
> = (() => {
  const result: Record<string, { station_code: string; station_name: string }> =
    {};
  for (const [city, stations] of Object.entries(CITY_STATIONS)) {
    for (const station of stations) {
      if (station.station_name == city) {
        result[city] = station;
        break;
      }
    }
  }
  return result;
})(); //以城市名名为键的Station记录

const NAME_STATIONS: Record<
  string,
  { station_code: string; station_name: string }
> = (() => {
  const result: Record<string, { station_code: string; station_name: string }> =
    {};
  for (const station of Object.values(STATIONS)) {
    const station_name = station.station_name;
    result[station_name] = {
      station_code: station.station_code,
      station_name: station.station_name,
    };
  }
  return result;
})(); //以车站名为键的Station记录

const SEAT_SHORT_TYPES = {
  swz: '商务座',
  tz: '特等座',
  zy: '一等座',
  ze: '二等座',
  gr: '高软卧',
  srrb: '动卧',
  rw: '软卧',
  yw: '硬卧',
  rz: '软座',
  yz: '硬座',
  wz: '无座',
  qt: '其他',
  gg: '',
  yb: '',
};

const SEAT_TYPES = {
  '9': { name: '商务座', short: 'swz' },
  P: { name: '特等座', short: 'tz' },
  M: { name: '一等座', short: 'zy' },
  D: { name: '优选一等座', short: 'zy' },
  O: { name: '二等座', short: 'ze' },
  S: { name: '二等包座', short: 'ze' },
  '6': { name: '高级软卧', short: 'gr' },
  A: { name: '高级动卧', short: 'gr' },
  '4': { name: '软卧', short: 'rw' },
  I: { name: '一等卧', short: 'rw' },
  F: { name: '动卧', short: 'rw' },
  '3': { name: '硬卧', short: 'yw' },
  J: { name: '二等卧', short: 'yw' },
  '2': { name: '软座', short: 'rz' },
  '1': { name: '硬座', short: 'yz' },
  W: { name: '无座', short: 'wz' },
  WZ: { name: '无座', short: 'wz' },
  H: { name: '其他', short: 'qt' },
};

const DW_FLAGS = [
  '智能动车组',
  '复兴号',
  '静音车厢',
  '温馨动卧',
  '动感号',
  '支持选铺',
  '老年优惠',
];

const TRAIN_FILTERS = {
  //G(高铁/城际),D(动车),Z(直达特快),T(特快),K(快速),O(其他),F(复兴号),S(智能动车组)
  G: (ticketInfo: TicketInfo) => {
    return ticketInfo.train_no.startsWith('G') ||
      ticketInfo.train_no.startsWith('C')
      ? true
      : false;
  },
  D: (ticketInfo: TicketInfo) => {
    return ticketInfo.train_no.startsWith('D') ? true : false;
  },
  Z: (ticketInfo: TicketInfo) => {
    return ticketInfo.train_no.startsWith('Z') ? true : false;
  },
  T: (ticketInfo: TicketInfo) => {
    return ticketInfo.train_no.startsWith('T') ? true : false;
  },
  K: (ticketInfo: TicketInfo) => {
    return ticketInfo.train_no.startsWith('K') ? true : false;
  },
  O: (ticketInfo: TicketInfo) => {
    return TRAIN_FILTERS.G(ticketInfo) ||
      TRAIN_FILTERS.D(ticketInfo) ||
      TRAIN_FILTERS.Z(ticketInfo) ||
      TRAIN_FILTERS.T(ticketInfo) ||
      TRAIN_FILTERS.K(ticketInfo)
      ? false
      : true;
  },
  F: (ticketInfo: TicketInfo) => {
    return ticketInfo.dw_flag.includes('复兴号') ? true : false;
  },
  S: (ticketInfo: TicketInfo) => {
    return ticketInfo.dw_flag.includes('智能动车组') ? true : false;
  },
};

function parseCookies(cookies: Array<string>): Record<string, string> {
  const cookieRecord: Record<string, string> = {};
  cookies.forEach((cookie) => {
    // 提取键值对部分（去掉 Path、HttpOnly 等属性）
    const keyValuePart = cookie.split(';')[0];
    // 分割键和值
    const [key, value] = keyValuePart.split('=');
    // 存入对象
    if (key && value) {
      cookieRecord[key.trim()] = value.trim();
    }
  });
  return cookieRecord;
}

function formatCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

async function getCookie(url: string) {
  try {
    const response = await axios.get(url);
    const setCookieHeader = response.headers['set-cookie'];
    if (setCookieHeader) {
      return parseCookies(setCookieHeader);
    }
    return null;
  } catch (error) {
    console.error('Error making 12306 request:', error);
    return null;
  }
}

function parseRouteStationsData(rawData: Object[]): RouteStationData[] {
  const result: RouteStationData[] = [];
  for (const item of rawData) {
    result.push(item as RouteStationData);
  }
  return result;
}

function parseRouteStationsInfo(routeStationsData: RouteStationData[]): RouteStationInfo[]{
  const result: RouteStationInfo[] = [];
  routeStationsData.forEach((routeStationData,index)=>{
    if (index == 0){
      result.push({
        arrive_time: routeStationData.start_time,
        station_name: routeStationData.station_name,
        stopover_time: routeStationData.stopover_time,
        station_no: parseInt(routeStationData.station_no),
      });
    }
    else{
      result.push({
      arrive_time: routeStationData.arrive_time,
      station_name: routeStationData.station_name,
      stopover_time: routeStationData.stopover_time,
      station_no: parseInt(routeStationData.station_no),
    });
  }
  })
  return result;
}

function parseTicketsData(rawData: string[]): TicketData[] {
  const result: TicketData[] = [];
  for (const item of rawData) {
    const values = item.split('|');
    const entry: Partial<TicketData> = {};
    TicketDataKeys.forEach((key, index) => {
      entry[key] = values[index];
    });
    result.push(entry as TicketData);
  }
  return result;
}

function parseTicketsInfo(ticketsData: TicketData[]): TicketInfo[] {
  const result: TicketInfo[] = [];
  for (const ticket of ticketsData) {
    const prices = extractPrices(ticket);
    const dw_flag = extractDWFlags(ticket);
    result.push({
      train_no: ticket.train_no,
      start_train_code: ticket.station_train_code,
      start_time: ticket.start_time,
      arrive_time: ticket.arrive_time,
      lishi: ticket.lishi,
      from_station: STATIONS[ticket.from_station_telecode].station_name,
      to_station: STATIONS[ticket.to_station_telecode].station_name,
      from_station_telecode: ticket.from_station_telecode,
      to_station_telecode: ticket.to_station_telecode,
      prices: prices,
      dw_flag: dw_flag,
    });
  }
  return result;
}

function formatTicketsInfo(ticketsInfo: TicketInfo[]): string {
  if (ticketsInfo.length === 0) {
    return '没有查询到相关车次信息';
  }
  let result = '车次 | 出发站 -> 到达站 | 出发时间 -> 到达时间 | 历时 |';
  ticketsInfo.forEach((ticketInfo) => {
    let infoStr = '';
    infoStr += `${ticketInfo.start_train_code}(实际车次train_no: ${ticketInfo.train_no}) ${ticketInfo.from_station}(telecode: ${ticketInfo.from_station_telecode}) -> ${ticketInfo.to_station}(telecode: ${ticketInfo.to_station_telecode}) ${ticketInfo.start_time} -> ${ticketInfo.arrive_time} 历时：${ticketInfo.lishi}`;
    ticketInfo.prices.forEach((price) => {
      infoStr += `\n- ${price.seat_name}: ${
        price.num.match(/^\d+$/) ? price.num + '张' : price.num
      }剩余 ${price.price}元`;
    });
    result += `${infoStr}\n`;
  });
  return result;
}

function filterTicketsInfo(
  ticketsInfo: TicketInfo[],
  filters: string
): TicketInfo[] {
  if (filters.length === 0) {
    return ticketsInfo;
  }
  const result: TicketInfo[] = [];
  for (const ticketInfo of ticketsInfo) {
    for (const filter of filters) {
      if (TRAIN_FILTERS[filter as keyof typeof TRAIN_FILTERS](ticketInfo)) {
        result.push(ticketInfo);
        break;
      }
    }
  }
  return result;
}

function parseStationsData(rawData: string): Record<string, StationData> {
  const result: Record<string, StationData> = {};
  const dataArray = rawData.split('|');
  const dataList: string[][] = [];
  for (let i = 0; i < Math.floor(dataArray.length / 10); i++) {
    dataList.push(dataArray.slice(i * 10, i * 10 + 10));
  }
  for (const group of dataList) {
    let station: Partial<StationData> = {};
    StationDataKeys.forEach((key, index) => {
      station[key] = group[index];
    });
    if (!station.station_code) {
      continue;
    }
    result[station.station_code!] = station as StationData;
  }
  return result;
}

function extractPrices(ticketData: TicketData): Price[] {
  const PRICE_STR_LENGTH = 10;
  const DISCOUNT_STR_LENGTH = 5;

  const yp_ex = ticketData.yp_ex;
  const yp_info_new = ticketData.yp_info_new;
  const seat_discount_info = ticketData.seat_discount_info;

  const prices: { [key: string]: Price } = {};
  const discounts: { [key: string]: number } = {};
  for (let i = 0; i < seat_discount_info.length / DISCOUNT_STR_LENGTH; i++) {
    const discount_str = seat_discount_info.slice(
      i * DISCOUNT_STR_LENGTH,
      (i + 1) * DISCOUNT_STR_LENGTH
    );
    discounts[discount_str[0]] = parseInt(discount_str.slice(1), 10);
  }

  const exList = yp_ex.split('0').filter(Boolean); // Remove empty strings
  exList.forEach((ex, index) => {
    const seat_type = SEAT_TYPES[ex as keyof typeof SEAT_TYPES];
    const price_str = yp_info_new.slice(
      index * PRICE_STR_LENGTH,
      (index + 1) * PRICE_STR_LENGTH
    );
    const price = parseInt(price_str.slice(1, -5), 10);
    const discount = ex in discounts ? discounts[ex] : null;
    prices[ex] = {
      seat_name: seat_type.name,
      short: seat_type.short,
      seat_type_code: ex,
      num: ticketData[`${seat_type.short}_num` as keyof TicketData],
      price,
      discount,
    };
  });

  return Object.values(prices);
}

function extractDWFlags(ticketData: TicketData): string[] {
  const dwFlagList = ticketData.dw_flag.split('#');
  let result = [];
  if ('5' == dwFlagList[0]) {
    result.push(DW_FLAGS[0]);
  }
  if (dwFlagList.length > 1 && '1' == dwFlagList[1]) {
    result.push(DW_FLAGS[1]);
  }
  if (dwFlagList.length > 2) {
    if ('Q' == dwFlagList[2].substring(0, 1)) {
      result.push(DW_FLAGS[2]);
    } else if ('R' == dwFlagList[2].substring(0, 1)) {
      result.push(DW_FLAGS[3]);
    }
  }
  if (dwFlagList.length > 5 && 'D' == dwFlagList[5]) {
    result.push(DW_FLAGS[4]);
  }
  if (dwFlagList.length > 6 && 'z' != dwFlagList[6]) {
    result.push(DW_FLAGS[5]);
  }
  if (dwFlagList.length > 7 && 'z' != dwFlagList[7]) {
    result.push(DW_FLAGS[6]);
  }
  return result;
}

async function make12306Request<T>(
  url: string | URL,
  scheme: URLSearchParams = new URLSearchParams(),
  headers: Record<string, string> = {}
): Promise<T | null> {
  try {
    const response = await axios.get(url + '?' + scheme.toString(), {
      headers: headers,
    });
    return (await response.data) as T;
  } catch (error) {
    console.error('Error making 12306 request:', error);
    return null;
  }
}

// Create server instance
const server = new McpServer({
  name: '12306-mcp',
  version: '1.0.0',
  capabilities: {
    resources: {},
    tools: {},
  },
  instructions:
    'This server provides information about 12306.You can use this server to query train tickets on 12306.',
});

interface QueryResponse {
  [key: string]: any;
  httpstatus: string;
  data: {
    [key: string]: any;
  };
  messages: string;
  status: boolean;
}

server.resource('stations', 'data://all-stations', async (uri) => ({
  contents: [
    {
      uri: uri.href,
      text: JSON.stringify(STATIONS),
    },
  ],
}));

server.tool(
  'get-stations-code-in-city',
  '通过城市名查询该城市所有车站的station_code',
  {
    city: z.string().describe('中文城市名称'),
  },
  async ({ city }) => {
    if (!(city in CITY_STATIONS)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: City not found. ',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(CITY_STATIONS[city]),
        },
      ],
    };
  }
);

server.tool(
  'get-station-code-of-city',
  '通过城市名查询该城市对应的station_code',
  {
    city: z.string().describe('中文城市名称'),
  },
  async ({ city }) => {
    if (!(city in CITY_CODES)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: City not found. ',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(CITY_CODES[city]),
        },
      ],
    };
  }
);

server.tool(
  'get-station-code-by-name',
  '通过车站名查询station_code',
  {
    stationName: z.string().describe('中文车站名称'),
  },
  async ({ stationName }) => {
    stationName = stationName.endsWith('站')
      ? stationName.substring(0, -1)
      : stationName;
    if (!(stationName in NAME_STATIONS)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Station not found. ',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(NAME_STATIONS[stationName]),
        },
      ],
    };
  }
);

server.tool(
  'get-tickets',
  '查询12306余票信息。',
  {
    date: z.string().length(10).describe('日期( 格式: yyyy-mm-dd )'),
    fromStation: z
      .string()
      .describe('出发车站的station_code 或 出发城市的station_code'),
    toStation: z
      .string()
      .describe('到达车站的station_code 或 出发城市的station_code'),
    trainFilterFlags: z
      .string()
      .regex(/^[GDZTKOFS]*$/)
      .max(8)
      .optional()
      .default('')
      .describe(
        '车次筛选条件，默认为空。从以下标志中选取多个条件组合[G(高铁/城际),D(动车),Z(直达特快),T(特快),K(快速),O(其他),F(复兴号),S(智能动车组)]'
      ),
  },
  async ({ date, fromStation, toStation, trainFilterFlags }) => {
    // 检查日期是否早于当前日期
    if (new Date(date).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0)){
      return {
        content: [
          {
            type: 'text',
            text: 'Error: The date cannot be earlier than today.',
          },
        ],
      };
    }
    console.error(fromStation, toStation);
    console.error(Object.keys(STATIONS));
    if (!Object.keys(STATIONS).includes(fromStation) || !Object.keys(STATIONS).includes(toStation)){
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Station not found. ',
          },
        ],
      };
    }
    const queryParams = new URLSearchParams({
      'leftTicketDTO.train_date': date,
      'leftTicketDTO.from_station': fromStation,
      'leftTicketDTO.to_station': toStation,
      'purpose_codes': 'ADULT',
    });
    const queryUrl = `${API_BASE}/otn/leftTicket/query`;
    const cookies = await getCookie(API_BASE);
    if (cookies == null) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: get cookie failed. Check your network.',
          },
        ],
      };
    }
    const queryResponse = await make12306Request<QueryResponse>(
      queryUrl,
      queryParams,
      { Cookie: formatCookies(cookies) }
    );
    if (queryResponse === null || queryResponse === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: get tickets data failed. ',
          },
        ],
      };
    }
    const ticketsData = parseTicketsData(queryResponse.data.result);
    const ticketsInfo = parseTicketsInfo(ticketsData);
    const filteredTicketsInfo = filterTicketsInfo(
      ticketsInfo,
      trainFilterFlags
    );
    return {
      content: [
        {
          type: 'text',
          text: formatTicketsInfo(filteredTicketsInfo),
        },
      ],
    };
  }
);

server.tool(
  'get-train-route-stations',
  '查询列车途径车站信息。',
  {
    trainNo: z.string().describe('实际车次编号train_no，例如240000G10336.'),
    fromStationTelecode: z
    .string()
    .describe('出发车站的station_telecode_code，而非城市的station_code.'),
    toStationTelecode: z
    .string()
    .describe('到达车站的station_telecode_code，而非城市的station_code.'),
    departDate: z.string().length(10).describe('列车出发日期( 格式: yyyy-mm-dd )'),

  },
  async ({ trainNo: trainNo, fromStationTelecode, toStationTelecode, departDate}) => {
    const queryParams = new URLSearchParams({
      'train_no': trainNo,
      'from_station_telecode': fromStationTelecode,
      'to_station_telecode': toStationTelecode,
      'depart_date':departDate,
    });
    const queryUrl = `${API_BASE}/otn/czxx/queryByTrainNo`;
    const cookies = await getCookie(API_BASE);
    if (cookies == null) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: get cookie failed. ',
          },
        ],
      };
    }
    const queryResponse = await make12306Request<QueryResponse>(
      queryUrl,
      queryParams,
      { Cookie: formatCookies(cookies) }
    );
    if (queryResponse == null) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: get train route stations failed. ',
          },
        ],
      };
    }
    const routeStationsData = parseRouteStationsData(queryResponse.data.data);
    const routeStationsInfo = parseRouteStationsInfo(routeStationsData);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(routeStationsInfo),
        },
      ],
    };
  }
);

async function getStations(): Promise<Record<string, StationData>> {
  const html = await make12306Request<string>(WEB_URL);
  if (html == null) {
    throw new Error('Error: get 12306 web page failed.');
  }
  const match = html.match('.(/script/core/common/station_name.+?.js)');
  if (match == null) {
    throw new Error('Error: get station name js file failed.');
  }
  const stationNameJSFilePath = match[0];
  const stationNameJS = await make12306Request<string>(
    new URL(stationNameJSFilePath, WEB_URL)
  );
  if (stationNameJS == null) {
    throw new Error('Error: get station name js file failed.');
  }
  const rawData = eval(stationNameJS.replace('var station_names =', ''));
  const stationsData = parseStationsData(rawData);
  return stationsData;
}

async function init() {}

async function main() {
  const transport = new StdioServerTransport();
  await init();
  await server.connect(transport);
  console.error('12306 MCP Server running on stdio @Joooook');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
